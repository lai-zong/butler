'use client';

/**
 * 设置 · 登录与安全
 *
 * ★ 做五件事：说明登录状态、改密码、补设/替换找回问题、退出登录、解释边界。
 *   没有“关闭登录 / 停用”，也不提供任何绕过入口——本地登录是强制的。
 *
 * ★ 找回问题：
 *   答案只在服务端保存哈希；旧版认证文件没有 securityQuestion，
 *   所以这里必须提供“补设”入口，否则那些电脑忘记密码就没法重置。
 *
 * ★ 会话过期（401 invalid_session）在这里给出明确出口：
 *   设置页是最容易在长时间停留后收到 401 的地方，不能只说“请求失败”。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Icon } from '../components/Icon';
import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { PasswordField } from '../auth/PasswordField';
import { SecurityAnswerField, SecurityQuestionSelect } from '../auth/SecurityQuestionFields';
import {
  ANSWER_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  answerRuleError,
  asAuthError,
  changeLocalPassword,
  getAuthStatus,
  logoutAuth,
  passwordRuleError,
  setSecurityQuestion,
  type LocalAuthStatus,
} from '../auth/authClient.js';
import { useRetryCountdown } from '../auth/useRetryCountdown.js';
import type { ToastMessage } from '../lib/types.js';

interface LocalAuthPanelProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

export function LocalAuthPanel({ notify }: LocalAuthPanelProps): JSX.Element {
  const [status, setStatus] = useState<LocalAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const retry = useRetryCountdown();

  const [securityCurrentPassword, setSecurityCurrentPassword] = useState('');
  const [securityQuestionId, setSecurityQuestionId] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [securityCurrentError, setSecurityCurrentError] = useState<string | null>(null);
  const [securityQuestionError, setSecurityQuestionError] = useState<string | null>(null);
  const [securityAnswerError, setSecurityAnswerError] = useState<string | null>(null);
  const [securityFormError, setSecurityFormError] = useState<string | null>(null);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const securitySavingRef = useRef(false);
  const securityRetry = useRetryCountdown();

  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await getAuthStatus();
        if (cancelled) return;
        setStatus(next);
        setSecurityQuestionId(next.securityQuestion?.id ?? '');
        if (!next.authenticated) setSessionExpired(true);
      } catch (err) {
        if (!cancelled) setLoadError(asAuthError(err).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitChange(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current || retry.remaining !== null) return;

    let invalid = false;
    if (currentPassword.length === 0) {
      setCurrentError('请输入当前密码');
      invalid = true;
    }
    const newProblem = newPassword.length === 0 ? '请输入新密码' : passwordRuleError(newPassword);
    if (newProblem !== null) {
      setNewError(newProblem);
      invalid = true;
    }
    if (confirmPassword.length === 0) {
      setConfirmError('请再输入一次新密码');
      invalid = true;
    } else if (confirmPassword !== newPassword) {
      setConfirmError('两次输入的密码不一致');
      invalid = true;
    }
    if (invalid) return;

    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    try {
      await changeLocalPassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setCurrentError(null);
      setNewError(null);
      setConfirmError(null);
      notify('密码已更新', 'success');
    } catch (err) {
      const authError = asAuthError(err);
      if (
        authError.status === 401 &&
        authError.code !== 'invalid_session' &&
        authError.code !== 'not_configured'
      ) {
        setCurrentError('当前密码不正确');
        setCurrentPassword('');
      } else if (authError.status === 401 || authError.code === 'invalid_session') {
        setSessionExpired(true);
        setFormError('登录已失效，请重新登录后再改密码。');
      } else if (authError.status === 400) {
        setNewError(authError.message);
      } else if (authError.code === 'rate_limited' || authError.status === 429) {
        retry.start(authError.retryAfterSeconds ?? 60);
      } else if (authError.status === 409 || authError.code === 'not_configured') {
        setSessionExpired(true);
        setFormError('本地登录还没有设置；请先完成首次设置。');
      } else {
        setFormError(authError.message);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function submitSecurity(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (securitySavingRef.current || securityRetry.remaining !== null) return;

    let invalid = false;
    if (securityCurrentPassword.length === 0) {
      setSecurityCurrentError('请输入当前密码');
      invalid = true;
    }
    if (securityQuestionId.length === 0) {
      setSecurityQuestionError('请选择一个找回问题');
      invalid = true;
    }
    const answerProblem =
      securityAnswer.length === 0 ? '请填写答案' : answerRuleError(securityAnswer);
    if (answerProblem !== null) {
      setSecurityAnswerError(answerProblem);
      invalid = true;
    }
    if (invalid) return;

    const wasSet = status !== null && status.securityQuestion !== null;
    securitySavingRef.current = true;
    setSavingSecurity(true);
    setSecurityFormError(null);
    try {
      const question = await setSecurityQuestion(
        securityCurrentPassword,
        securityQuestionId,
        securityAnswer,
      );
      setStatus((prev) => (prev === null ? prev : { ...prev, securityQuestion: question }));
      setSecurityQuestionId(question.id);
      setSecurityCurrentPassword('');
      setSecurityAnswer('');
      setSecurityCurrentError(null);
      setSecurityQuestionError(null);
      setSecurityAnswerError(null);
      notify(wasSet ? '找回问题已更新' : '找回问题已设置', 'success');
    } catch (err) {
      const authError = asAuthError(err);
      if (
        authError.status === 401 &&
        authError.code !== 'invalid_session' &&
        authError.code !== 'not_configured'
      ) {
        setSecurityCurrentError('当前密码不正确');
        setSecurityCurrentPassword('');
      } else if (authError.status === 401 || authError.code === 'invalid_session') {
        setSessionExpired(true);
        setSecurityFormError('登录已失效，请重新登录后再设置找回问题。');
      } else if (authError.code === 'invalid_question') {
        setSecurityQuestionError(authError.message);
      } else if (authError.code === 'invalid_answer') {
        setSecurityAnswerError(authError.message);
      } else if (authError.code === 'invalid_password') {
        setSecurityCurrentError(authError.message);
      } else if (authError.status === 400) {
        setSecurityFormError(authError.message);
      } else if (authError.code === 'rate_limited' || authError.status === 429) {
        securityRetry.start(authError.retryAfterSeconds ?? 60);
      } else if (authError.status === 409 || authError.code === 'not_configured') {
        setSessionExpired(true);
        setSecurityFormError('本地登录还没有设置；请先完成首次设置。');
      } else {
        setSecurityFormError(authError.message);
      }
    } finally {
      securitySavingRef.current = false;
      setSavingSecurity(false);
    }
  }

  async function signOut(): Promise<void> {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    try {
      await logoutAuth();
      window.location.replace('/login');
    } catch (err) {
      notify(asAuthError(err).message, 'danger');
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  }

  const configured = status !== null && status.configured;
  const question = status?.securityQuestion ?? null;

  return (
    <section className="panel settings-panel" aria-busy={saving || savingSecurity || signingOut}>
      <SectionHeading
        title="本地登录"
        actions={
          <div className="localauth-head-badges">
            <Badge tone={configured ? 'accent' : 'warn'}>
              <Icon name="lock" size={12} /> {configured ? '已开启' : '未设置'}
            </Badge>
            <Badge tone={question === null ? 'warn' : 'outline'}>
              <Icon name="shield" size={12} /> 找回问题：{question?.label ?? '未设置'}
            </Badge>
          </div>
        }
      />

      {loading ? (
        <Skeleton rows={3} height={14} />
      ) : loadError !== null ? (
        <InlineError message={loadError} onRetry={() => window.location.reload()} />
      ) : (
        <>
          {sessionExpired && (
            <div className="localauth-expired" role="alert">
              <span className="localauth-expired-icon" aria-hidden="true">
                <Icon name="alert" size={16} />
              </span>
              <div>
                <strong>登录已失效，请重新登录</strong>
                <p>当前页面仍可查看，但修改密码、找回问题或退出登录需要有效的会话。</p>
              </div>
              <a className="btn btn-ghost btn-sm" href="/login?next=%2F%23%2Fsettings">
                去登录
              </a>
            </div>
          )}


          <section className="localauth-block" aria-labelledby="localauth-password-heading">
            <h3 id="localauth-password-heading" className="localauth-block-title">
              修改密码
            </h3>
            <p className="localauth-block-desc">
              改完后会立即轮换登录凭据：其它浏览器里的旧会话失效；找回问题保持不变。
            </p>

            <form className="localauth-form" onSubmit={(event) => void submitChange(event)} noValidate>
              <PasswordField
                id="localauth-current-password"
                label="当前密码"
                value={currentPassword}
                onChange={(next) => {
                  setCurrentPassword(next);
                  if (currentError !== null) setCurrentError(null);
                }}
                autoComplete="current-password"
                placeholder="输入当前密码"
                error={currentError}
                disabled={saving || sessionExpired}
                maxLength={PASSWORD_MAX_LENGTH}
              />

              <div className="localauth-passwords">
                <PasswordField
                  id="localauth-new-password"
                  label="新密码"
                  value={newPassword}
                  onChange={(next) => {
                    setNewPassword(next);
                    if (newError !== null) setNewError(null);
                  }}
                  autoComplete="new-password"
                  placeholder="至少 8 位"
                  error={newError}
                  disabled={saving || sessionExpired}
                  maxLength={PASSWORD_MAX_LENGTH}
                />
                <PasswordField
                  id="localauth-confirm-password"
                  label="确认新密码"
                  value={confirmPassword}
                  onChange={(next) => {
                    setConfirmPassword(next);
                    if (confirmError !== null) setConfirmError(null);
                  }}
                  autoComplete="new-password"
                  placeholder="再输入一次"
                  error={confirmError}
                  disabled={saving || sessionExpired}
                  maxLength={PASSWORD_MAX_LENGTH}
                />
              </div>

              {formError !== null && (
                <p className="auth-notice is-error" role="alert">
                  <Icon name="alert" size={14} />
                  <span>{formError}</span>
                </p>
              )}

              {retry.remaining !== null && (
                <p className="auth-notice is-warn" role="alert">
                  <Icon name="clock" size={14} />
                  <span>
                    尝试过多，请 <strong className="mono">{retry.remaining}</strong> 秒后再试。
                  </span>
                </p>
              )}

              <div className="localauth-actions">
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={saving || sessionExpired || retry.remaining !== null}
                >
                  {saving ? '正在更新…' : '更新密码'}
                </button>
                <span className="localauth-hint">密码不会离开这台电脑。</span>
              </div>
            </form>
          </section>

          <section className="localauth-block" aria-labelledby="localauth-security-heading">
            <h3 id="localauth-security-heading" className="localauth-block-title">
              找回问题
            </h3>
            <form
              className="localauth-form"
              onSubmit={(event) => void submitSecurity(event)}
              noValidate
            >
              <PasswordField
                id="localauth-security-current-password"
                label="当前密码"
                value={securityCurrentPassword}
                onChange={(next) => {
                  setSecurityCurrentPassword(next);
                  if (securityCurrentError !== null) setSecurityCurrentError(null);
                }}
                autoComplete="current-password"
                placeholder="确认是你本人"
                error={securityCurrentError}
                disabled={savingSecurity || sessionExpired}
                maxLength={PASSWORD_MAX_LENGTH}
              />

              <SecurityQuestionSelect
                id="localauth-security-question"
                value={securityQuestionId}
                onChange={(next) => {
                  setSecurityQuestionId(next);
                  if (securityQuestionError !== null) setSecurityQuestionError(null);
                }}
                disabled={savingSecurity || sessionExpired}
                error={securityQuestionError}
              />

              <SecurityAnswerField
                id="localauth-security-answer"
                value={securityAnswer}
                onChange={(next) => {
                  setSecurityAnswer(next);
                  if (securityAnswerError !== null) setSecurityAnswerError(null);
                }}
                placeholder="填写只有你知道的答案"
                error={securityAnswerError}
                disabled={savingSecurity || sessionExpired}
                maxLength={ANSWER_MAX_LENGTH}
              />

              {securityFormError !== null && (
                <p className="auth-notice is-error" role="alert">
                  <Icon name="alert" size={14} />
                  <span>{securityFormError}</span>
                </p>
              )}

              {securityRetry.remaining !== null && (
                <p className="auth-notice is-warn" role="alert">
                  <Icon name="clock" size={14} />
                  <span>
                    尝试过多，请 <strong className="mono">{securityRetry.remaining}</strong> 秒后再试。
                  </span>
                </p>
              )}

              <div className="localauth-actions">
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={savingSecurity || sessionExpired || securityRetry.remaining !== null}
                >
                  {savingSecurity
                    ? '正在保存…'
                    : question === null
                      ? '设置找回问题'
                      : '更新找回问题'}
                </button>
              </div>
            </form>
          </section>

          <section className="localauth-block" aria-labelledby="localauth-signout-heading">
            <div className="localauth-signout">
              <div>
                <h3 id="localauth-signout-heading" className="localauth-block-title">
                  退出登录
                </h3>
                <p>退出后回到登录页；下次打开 butler 需要重新输入密码。</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut ? '正在退出…' : '退出登录'}
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
