'use client';

/**
 * 登录页（/login）—— 密码登录与“用找回问题重置密码”同页切换。
 *
 * ★ 只有一个密码框：没有用户名，也没有注册。
 *
 * ★ 回跳只认站内路径：`next` 经 safeNextPath 清洗，外部地址一律回 `/`。
 *
 * ★ 失败按状态分流：
 *   401 密码错（清空输入、重新聚焦）
 *   409 还没设置 → /setup
 *   429 记住 Retry-After 并倒计时
 *   503 认证文件损坏 → 只给删文件重启这一条官方路径
 *
 * ★ 找回方式只有找回问题：status 里的 securityQuestion 决定能不能重置；
 *   重置成功服务端直接写会话 cookie，页面直接进入 butler。
 *   旧认证文件没有问题时，只提示去设置页补设，不提供任何绕过入口。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Icon } from '../components/Icon';
import { AuthFatalView, authFatalFrom, type AuthFatal } from './AuthFatalView';
import { AuthShell } from './AuthShell';
import { PasswordField } from './PasswordField';
import { SecurityAnswerField } from './SecurityQuestionFields';
import {
  ANSWER_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  answerRuleError,
  asAuthError,
  getAuthStatus,
  loginWithPassword,
  passwordRuleError,
  resetAuthWithAnswer,
  safeNextPath,
  type SecurityQuestion,
} from './authClient.js';
import { useRetryCountdown } from './useRetryCountdown.js';

type LoginMode = 'login' | 'reset';

interface LoginViewProps {
  readonly initialNext?: string | null | undefined;
}

export function LoginView({ initialNext }: LoginViewProps): JSX.Element {
  const nextPath = safeNextPath(initialNext ?? null);

  const [mode, setMode] = useState<LoginMode>('login');
  const [fatal, setFatal] = useState<AuthFatal | null>(null);
  const [securityQuestion, setSecurityQuestion] = useState<SecurityQuestion | null>(null);

  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const signingInRef = useRef(false);
  const loginRetry = useRetryCountdown();

  const [resetAnswer, setResetAnswer] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const resettingRef = useRef(false);
  const resetRetry = useRetryCountdown();

  const passwordRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);

  /**
   * 进入页面先问 status：
   *   - 已登录 → 直接回 next（避免登录页闪一下）
   *   - 还没设置 → /setup（带上同一个 next）
   *   - 未登录 → 显示登录表单，并记下找回问题是否存在
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getAuthStatus();
        if (cancelled) return;
        if (!status.configured) {
          window.location.replace(`/setup?next=${encodeURIComponent(nextPath)}`);
          return;
        }
        if (status.authenticated) {
          window.location.replace(nextPath);
          return;
        }
        setSecurityQuestion(status.securityQuestion);
      } catch (err) {
        if (cancelled) return;
        setFatal(authFatalFrom(asAuthError(err)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nextPath]);

  // 模式切换后把焦点放到第一个可输入项，键盘用户不用 Tab 找。
  useEffect(() => {
    if (fatal !== null) return;
    if (mode === 'login') passwordRef.current?.focus();
    else if (securityQuestion !== null) answerRef.current?.focus();
  }, [mode, fatal, securityQuestion]);

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (signingInRef.current || loginRetry.remaining !== null) return;
    if (password.length === 0) {
      setPasswordError('请输入密码');
      passwordRef.current?.focus();
      return;
    }

    signingInRef.current = true;
    setSigningIn(true);
    setPasswordError(null);
    setFormError(null);
    try {
      await loginWithPassword(password);
      // 整页跳转：确保 middleware 与新 cookie 一起生效，不用客户端缓存赌一次。
      window.location.assign(nextPath);
    } catch (err) {
      const authError = asAuthError(err);
      if (authError.status === 401) {
        setPasswordError('密码不正确，请重新输入');
        setPassword('');
        window.requestAnimationFrame(() => passwordRef.current?.focus());
      } else if (authError.status === 409 || authError.code === 'not_configured') {
        window.location.replace(`/setup?next=${encodeURIComponent(nextPath)}`);
      } else if (authError.code === 'rate_limited' || authError.status === 429) {
        loginRetry.start(authError.retryAfterSeconds ?? 60);
      } else if (authError.status === 503) {
        setFatal(authFatalFrom(authError));
      } else {
        setFormError(authError.message);
      }
    } finally {
      signingInRef.current = false;
      setSigningIn(false);
    }
  }

  function openReset(): void {
    setMode('reset');
    setPasswordError(null);
    setFormError(null);
    setResetAnswer('');
    setNewPassword('');
    setConfirmPassword('');
    setAnswerError(null);
    setNewPasswordError(null);
    setConfirmPasswordError(null);
    setResetError(null);
    resetRetry.clear();
  }

  function goToLogin(): void {
    setMode('login');
    setResetAnswer('');
    setNewPassword('');
    setConfirmPassword('');
    setAnswerError(null);
    setNewPasswordError(null);
    setConfirmPasswordError(null);
    setResetError(null);
    setPassword('');
    setPasswordError(null);
    setFormError(null);
  }

  async function submitReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (resettingRef.current || resetRetry.remaining !== null) return;
    if (securityQuestion === null) return;

    let invalid = false;
    let answerInvalid = false;
    let passwordInvalid = false;
    const answerProblem =
      resetAnswer.length === 0 ? '请填写找回问题答案' : answerRuleError(resetAnswer);
    if (answerProblem !== null) {
      setAnswerError(answerProblem);
      answerInvalid = true;
      invalid = true;
    }
    const passwordProblem =
      newPassword.length === 0 ? '请输入新密码' : passwordRuleError(newPassword);
    if (passwordProblem !== null) {
      setNewPasswordError(passwordProblem);
      passwordInvalid = true;
      invalid = true;
    }
    if (confirmPassword.length === 0) {
      setConfirmPasswordError('请再输入一次新密码');
      passwordInvalid = true;
      invalid = true;
    } else if (confirmPassword !== newPassword) {
      setConfirmPasswordError('两次输入的密码不一致');
      passwordInvalid = true;
      invalid = true;
    }
    if (invalid) {
      if (answerInvalid) answerRef.current?.focus();
      else if (passwordInvalid) newPasswordRef.current?.focus();
      return;
    }

    resettingRef.current = true;
    setResetting(true);
    setResetError(null);
    try {
      await resetAuthWithAnswer(resetAnswer, newPassword);
      setResetAnswer('');
      setNewPassword('');
      setConfirmPassword('');
      setAnswerError(null);
      setNewPasswordError(null);
      setConfirmPasswordError(null);
      // 重置成功会 Set-Cookie：直接进入应用，不再要求用新密码登录一次。
      window.location.assign(nextPath);
    } catch (err) {
      const authError = asAuthError(err);
      if (authError.status === 401 || authError.code === 'invalid_answer') {
        if (authError.status === 401) {
          setAnswerError('答案不正确，请检查后重试');
          setResetAnswer('');
          window.requestAnimationFrame(() => answerRef.current?.focus());
        } else {
          setAnswerError(authError.message);
        }
      } else if (authError.code === 'invalid_password') {
        setNewPasswordError(authError.message);
      } else if (authError.code === 'security_not_configured' || authError.status === 409) {
        if (authError.code === 'security_not_configured') {
          // 旧认证文件没有找回问题：切回“去设置页补设”的说明。
          setSecurityQuestion(null);
          setResetError(null);
        } else {
          window.location.replace(`/setup?next=${encodeURIComponent(nextPath)}`);
        }
      } else if (authError.code === 'rate_limited' || authError.status === 429) {
        resetRetry.start(authError.retryAfterSeconds ?? 60);
      } else if (authError.status === 503) {
        setFatal(authFatalFrom(authError));
      } else {
        setResetError(authError.message);
      }
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  }

  const head = fatal !== null
    ? {
        eyebrow: '访问受阻',
        title: '暂时无法登录',
        description: '本地认证不可用；页面不会提供任何绕过入口。',
      }
      : mode === 'reset'
        ? securityQuestion === null
          ? {
              eyebrow: '找回访问',
              title: '还没有找回问题',
              description: '这台电脑的认证文件是旧版，还没有设置找回问题。',
            }
          : {
              eyebrow: '找回访问',
              title: '回答找回问题',
              description: '答对设置时选的问题，就能重设密码并直接进入 butler。',
            }
        : {
            eyebrow: '本地登录',
            title: '欢迎回来',
            description: '输入这台电脑上设置的密码。这里没有用户名，只有你自己。',
          };

  return (
    <AuthShell eyebrow={head.eyebrow} title={head.title} description={head.description}>
      {fatal !== null ? (
        <AuthFatalView fatal={fatal} />
      ) : mode === 'reset' ? (
        securityQuestion === null ? (
          <div className="auth-form">
            <p className="auth-notice is-warn" role="alert">
              <Icon name="alert" size={14} />
              <span>这台电脑还没有设置找回问题；登录后在「设置 → 登录与安全」补设。</span>
            </p>
            <p className="auth-form-note">补设之后，忘记密码时就可以用问题答案重置。</p>
            <button type="button" className="btn btn-primary auth-submit" onClick={goToLogin}>
              返回登录
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={(event) => void submitReset(event)} noValidate>
            <div className="auth-fields">
              <div className="auth-field">
                <label>找回问题</label>
                <p className="auth-question">{securityQuestion.label}</p>
              </div>

              <SecurityAnswerField
                id="reset-answer"
                value={resetAnswer}
                onChange={(next) => {
                  setResetAnswer(next);
                  if (answerError !== null) setAnswerError(null);
                }}
                placeholder="填写设置时的答案"
                error={answerError}
                disabled={resetting}
                inputRef={answerRef}
                maxLength={ANSWER_MAX_LENGTH}
              />
              <PasswordField
                id="reset-password"
                label="新密码"
                value={newPassword}
                onChange={(next) => {
                  setNewPassword(next);
                  if (newPasswordError !== null) setNewPasswordError(null);
                }}
                autoComplete="new-password"
                placeholder="至少 8 位"
                hint="重置成功后会用新密码直接进入 butler。"
                error={newPasswordError}
                disabled={resetting}
                inputRef={newPasswordRef}
                maxLength={PASSWORD_MAX_LENGTH}
              />
              <PasswordField
                id="reset-confirm"
                label="确认新密码"
                value={confirmPassword}
                onChange={(next) => {
                  setConfirmPassword(next);
                  if (confirmPasswordError !== null) setConfirmPasswordError(null);
                }}
                autoComplete="new-password"
                placeholder="再输入一次"
                error={confirmPasswordError}
                disabled={resetting}
                maxLength={PASSWORD_MAX_LENGTH}
              />
            </div>

            {resetError !== null && (
              <p className="auth-notice is-error" role="alert">
                <Icon name="alert" size={14} />
                <span>{resetError}</span>
              </p>
            )}

            {resetRetry.remaining !== null && (
              <p className="auth-notice is-warn" role="alert">
                <Icon name="clock" size={14} />
                <span>
                  尝试过多，请 <strong className="mono">{resetRetry.remaining}</strong> 秒后再试。
                </span>
              </p>
            )}

            <button
              type="submit"
              className="btn btn-primary auth-submit"
              disabled={resetting || resetRetry.remaining !== null}
            >
              {resetting ? '正在重置…' : '重置密码并进入'}
            </button>

            <div className="auth-alt">
              <span>想起密码了？</span>
              <button type="button" className="auth-link" onClick={goToLogin}>
                返回登录
              </button>
            </div>
          </form>
        )
      ) : (
        <form className="auth-form" onSubmit={(event) => void submitLogin(event)} noValidate>
          <PasswordField
            id="login-password"
            label="密码"
            value={password}
            onChange={(next) => {
              setPassword(next);
              if (passwordError !== null) setPasswordError(null);
            }}
            autoComplete="current-password"
            placeholder="输入本机密码"
            error={passwordError}
            disabled={signingIn}
            inputRef={passwordRef}
            maxLength={PASSWORD_MAX_LENGTH}
          />

          {formError !== null && (
            <p className="auth-notice is-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{formError}</span>
            </p>
          )}

          {loginRetry.remaining !== null && (
            <p className="auth-notice is-warn" role="alert">
              <Icon name="clock" size={14} />
              <span>
                尝试过多，请 <strong className="mono">{loginRetry.remaining}</strong> 秒后再试。
              </span>
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary auth-submit"
            disabled={signingIn || loginRetry.remaining !== null}
          >
            {signingIn ? '正在登录…' : '登录'}
          </button>

          <p className="auth-form-note">登录状态会保持 7 天；想提前结束，可在设置里退出。</p>

          <div className="auth-alt">
            <span>忘记密码？</span>
            <button type="button" className="auth-link" onClick={openReset}>
              用找回问题重置
            </button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}
