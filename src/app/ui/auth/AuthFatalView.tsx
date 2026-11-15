'use client';

/**
 * 认证不可用时的统一说明。
 *
 * ★ 三条克制：
 *   · 认证文件损坏只给“删文件 + 重启”这一条官方路径，不做自动绕过；
 *   · 连不上服务时只让重试，不暗示“跳过登录”；
 *   · 所有文案都说明删除认证文件不会动记忆与对话。
 */

import type { AuthRequestError } from './authClient.js';

export type AuthFatalKind = 'corrupt' | 'network' | 'unavailable';

export interface AuthFatal {
  readonly kind: AuthFatalKind;
  readonly message: string;
}

export function authFatalFrom(error: AuthRequestError): AuthFatal {
  if (error.code === 'auth_file_corrupt') return { kind: 'corrupt', message: error.message };
  if (error.status === 0) return { kind: 'network', message: error.message };
  return { kind: 'unavailable', message: error.message };
}

export function AuthFatalView({ fatal }: { readonly fatal: AuthFatal }): JSX.Element {
  if (fatal.kind === 'corrupt') {
    return (
      <div className="auth-fatal">
        <p className="auth-fatal-lead">
          本地认证文件损坏，无法验证密码。请按下面三步恢复访问：
        </p>
        <ol className="auth-steps">
          <li>关闭正在运行的 butler（终端窗口）。</li>
          <li>
            删除项目里的 <code className="auth-code">.butler-data/local-auth.json</code>。
          </li>
          <li>重新启动 butler，打开页面后按提示设置新密码。</li>
        </ol>
        <p className="auth-fatal-note">
          这是唯一的重置方式，页面不提供绕过登录的入口。删除认证文件只会重置登录，不会删除记忆、对话或已有文件。
        </p>
        <button
          type="button"
          className="btn btn-ghost auth-submit"
          onClick={() => window.location.reload()}
        >
          处理完了，重新加载
        </button>
      </div>
    );
  }

  if (fatal.kind === 'network') {
    return (
      <div className="auth-fatal">
        <p className="auth-fatal-lead">连不上本地服务。</p>
        <p className="auth-fatal-note">
          {fatal.message}
          <br />
          请确认终端窗口里的 butler 仍在运行，然后重新加载。
        </p>
        <button
          type="button"
          className="btn btn-ghost auth-submit"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }

  return (
    <div className="auth-fatal">
      <p className="auth-fatal-lead">本地认证暂时不可用。</p>
      <p className="auth-fatal-note">
        {fatal.message}
        <br />
        请查看终端里的服务端日志；如果需要，重启 butler 后再试。
      </p>
      <button
        type="button"
        className="btn btn-ghost auth-submit"
        onClick={() => window.location.reload()}
      >
        重试
      </button>
    </div>
  );
}

