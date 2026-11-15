'use client';

/**
 * 登录/设置页的外壳。
 *
 * ★ 为什么不用设置页那套布局：
 *   这两个页面在 middleware 之外，是进入 butler 之前唯一的门。
 *   居中、窄一栏、只放一件事，避免把“登录”做成第二套工作台。
 *
 * ★ 右下角没有营销文案：只保留一句本机访问控制的边界说明。
 */

import type { ReactNode } from 'react';

import { Icon } from '../components/Icon';

interface AuthShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode | undefined;
}

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
  footer,
}: AuthShellProps): JSX.Element {
  return (
    <main className="auth-screen">
      <div className="auth-texture" aria-hidden="true" />
      <div className="auth-wrap">
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">
            <Icon name="lock" size={18} strokeWidth={1.7} />
          </span>
          <span className="auth-brand-text">
            <strong>butler</strong>
            <span>本地访问控制</span>
          </span>
        </div>

        <section className="auth-card" aria-labelledby="auth-title">
          <header className="auth-head">
            <p className="auth-eyebrow">{eyebrow}</p>
            <h1 id="auth-title">{title}</h1>
            {description !== null && description !== undefined && description !== '' && (
              <p className="auth-desc">{description}</p>
            )}
          </header>
          {children}
        </section>

        {footer !== undefined && <div className="auth-footer">{footer}</div>}

      </div>
    </main>
  );
}
