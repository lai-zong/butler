'use client';

import { useEffect } from 'react';

import { ErrorView } from './ui/components/ErrorView.js';

/**
 * 根布局之外的错误兜底。
 *
 * global-error 会替换 root layout，因此必须自己渲染 <html>/<body>。
 * base.css 是否已加载由 Next 决定；ErrorView 的样式仍是普通 class，
 * 这里额外带上最少的背景/文字色，避免完全裸样式。
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): JSX.Element {
  useEffect(() => {
    console.error('[butler] global error:', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#f5f3ee', color: '#1e1d19' }}>
        <ErrorView reset={reset} {...(error.digest !== undefined ? { digest: error.digest } : {})} />
      </body>
    </html>
  );
}
