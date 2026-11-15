'use client';

/**
 * 首次设置页（/setup）。
 *
 * ★ 这是 middleware 之外的第一道门：认证文件不存在时唯一能做的事。
 *   没有“跳过”，也没有“稍后再说”；设置成功后才能进入 butler。
 *
 * ★ 密码和找回问题必须同时设置：忘记密码时只有“答对问题”这一条路。
 *   答案只保存哈希，前端不回显，也不生成任何一次性凭据。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Icon } from '../components/Icon';
import { AuthFatalView, authFatalFrom, type AuthFatal } from './AuthFatalView';
import { AuthShell } from './AuthShell';
import { PasswordField } from './PasswordField';
import { SecurityAnswerField, SecurityQuestionSelect } from './SecurityQuestionFields';
import {
  ANSWER_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  answerRuleError,
  asAuthError,
  getAuthStatus,
  passwordRuleError,
  safeNextPath,
  setupAuth,
} from './authClient.js';
import { useRetryCountdown } from './useRetryCountdown.js';

type SetupPhase = 'checking' | 'redirecting' | 'entering' | 'form';

interface SetupViewProps {
  readonly initialNext?: string | null | undefined;
}

export function SetupView({ initialNext }: SetupViewProps): JSX.Element {
  const nextPath = safeNextPath(initialNext ?? null);

  const [phase, setPhase] = useState<SetupPhase>('checking');
  const [fatal, setFatal] = useState<AuthFatal | null>(null);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [questionId, setQuestionId] = useState('');
  const [answer, setAnswer] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const retry = useRetryCountdown();

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    void (async () => {
      try {
        const status = await getAuthStatus();
        if (cancelled) return;
        if (status.configured) {
          setPhase('redirecting');
          timer = window.setTimeout(() => {
            window.location.replace(`/login?next=${encodeURIComponent(nextPath)}`);
          }, 1200);
          return;
        }
        setPhase('form');
      } catch (err) {
        if (cancelled) return;
        setFatal(authFatalFrom(asAuthError(err)));
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [nextPath]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current || retry.remaining !== null) return;

    let invalid = false;
    let passwordInvalid = false;
    const passwordProblem = password.length === 0 ? '请输入密码' : passwordRuleError(password);
    if (passwordProblem !== null) {
      setPasswordError(passwordProblem);
      passwordInvalid = true;
      invalid = true;
    }
    if (confirmPassword.length === 0) {
      setConfirmError('请再输入一次密码');
      passwordInvalid = true;
      invalid = true;
    } else if (confirmPassword !== password) {
      setConfirmError('两次输入的密码不一致');
      passwordInvalid = true;
      invalid = true;
    }
    if (questionId.length === 0) {
      setQuestionError('请选择一个找回问题');
      invalid = true;
    }
    const answerProblem = answer.length === 0 ? '请填写答案' : answerRuleError(answer);
    if (answerProblem !== null) {
      setAnswerError(answerProblem);
      invalid = true;
    }
    if (invalid) {
      if (passwordInvalid) passwordRef.current?.focus();
      else if (answerProblem !== null) answerRef.current?.focus();
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    try {
      await setupAuth(password, questionId, answer);
      setPassword('');
      setConfirmPassword('');
      setAnswer('');
      setPhase('entering');
      // 整页跳转：确保新 cookie 与 middleware 一起生效。
      window.location.assign(nextPath);
    } catch (err) {
      const authError = asAuthError(err);
      if (authError.code === 'invalid_password') {
        setPasswordError(authError.message);
      } else if (authError.code === 'invalid_question') {
        setQuestionError(authError.message);
      } else if (authError.code === 'invalid_answer') {
        setAnswerError(authError.message);
      } else if (authError.status === 400) {
        setFormError(authError.message);
      } else if (authError.status === 409) {
        // 另一标签页刚设置完：立刻让位给登录页。
        window.location.replace(`/login?next=${encodeURIComponent(nextPath)}`);
      } else if (authError.code === 'rate_limited' || authError.status === 429) {
        retry.start(authError.retryAfterSeconds ?? 60);
      } else if (authError.status === 503) {
        setFatal(authFatalFrom(authError));
      } else {
        setFormError(authError.message);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const head = fatal !== null
    ? {
        eyebrow: '访问受阻',
        title: '无法完成设置',
        description: '本地认证不可用；页面不会提供任何绕过入口。',
      }
    : phase === 'checking'
      ? {
          eyebrow: '首次启动',
          title: '正在准备…',
          description: '正在确认这台电脑是否已经设置过登录。',
        }
      : phase === 'redirecting'
        ? {
            eyebrow: '已经设置过',
            title: '本地登录已存在',
            description: '正在前往登录页；请直接用已设置的密码登录。',
          }
        : phase === 'entering'
          ? {
              eyebrow: '设置完成',
              title: '正在进入 butler',
              description: '密码和找回问题已经保存。',
            }
          : {
              eyebrow: '首次启动',
              title: '设置密码与找回问题',
              description: null,
            };

  return (
    <AuthShell eyebrow={head.eyebrow} title={head.title} description={head.description}>
      {fatal !== null ? (
        <AuthFatalView fatal={fatal} />
      ) : phase === 'checking' ? (
        <div className="auth-checking" role="status" aria-live="polite">
          <span className="auth-spinner" aria-hidden="true" />
          正在确认本地登录状态…
        </div>
      ) : phase === 'redirecting' ? (
        <div className="auth-form">
          <p className="auth-notice is-info" role="status">
            <Icon name="info" size={14} />
            <span>本地登录已经设置过，正在前往登录页…</span>
          </p>
          <a
            className="btn btn-ghost auth-submit"
            href={`/login?next=${encodeURIComponent(nextPath)}`}
          >
            立即前往登录
          </a>
        </div>
      ) : phase === 'entering' ? (
        <div className="auth-checking" role="status" aria-live="polite">
          <span className="auth-spinner" aria-hidden="true" />
          正在进入 butler…
        </div>
      ) : (
        <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
          <div className="auth-fields">
            <PasswordField
              id="setup-password"
              label="设置密码"
              value={password}
              onChange={(next) => {
                setPassword(next);
                if (passwordError !== null) setPasswordError(null);
              }}
              autoComplete="new-password"
              placeholder="至少 8 位"
              hint="这是这台电脑唯一的密码；没有用户名。"
              error={passwordError}
              disabled={saving}
              autoFocus
              inputRef={passwordRef}
              maxLength={PASSWORD_MAX_LENGTH}
            />
            <PasswordField
              id="setup-confirm"
              label="确认密码"
              value={confirmPassword}
              onChange={(next) => {
                setConfirmPassword(next);
                if (confirmError !== null) setConfirmError(null);
              }}
              autoComplete="new-password"
              placeholder="再输入一次"
              error={confirmError}
              disabled={saving}
              maxLength={PASSWORD_MAX_LENGTH}
            />
            <SecurityQuestionSelect
              id="setup-question"
              value={questionId}
              onChange={(next) => {
                setQuestionId(next);
                if (questionError !== null) setQuestionError(null);
              }}
              disabled={saving}
              error={questionError}
              hint="忘记密码时，用这个问题的答案重置。"
            />
            <SecurityAnswerField
              id="setup-answer"
              value={answer}
              onChange={(next) => {
                setAnswer(next);
                if (answerError !== null) setAnswerError(null);
              }}
              placeholder="填写只有你知道的答案"
              error={answerError}
              disabled={saving}
              inputRef={answerRef}
              maxLength={ANSWER_MAX_LENGTH}
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

          <button
            type="submit"
            className="btn btn-primary auth-submit"
            disabled={saving || retry.remaining !== null}
          >
            {saving ? '正在设置…' : '设置并进入'}
          </button>

          <p className="auth-form-note">
            设置成功后直接进入 butler；忘记密码时用上面的问题答案重置。
          </p>
        </form>
      )}
    </AuthShell>
  );
}
