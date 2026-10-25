'use client';

import { useEffect } from 'react';

import { ErrorView } from './ui/components/ErrorView.js';

export default function RouteError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): JSX.Element {
  useEffect(() => {
    // 只记录到本地控制台；界面不展示可能含路径/外部内容的 message。
    console.error('[butler] route error:', error);
  }, [error]);

  return <ErrorView reset={reset} {...(error.digest !== undefined ? { digest: error.digest } : {})} />;
}
