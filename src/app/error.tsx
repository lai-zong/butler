'use client';

/**
 * 路由级错误兜底（Next.js App Router 约定）
 *
 * ★ 兜住"整页都没渲染出来"的情况 —— 组件内部的错误由各自的边界处理，
 *   这里只保证：**页面挂掉时用户能看到一句人话，并且数据没有丢**。
 *
 * ⚠️ 完整错误只进控制台：界面上不给堆栈；
 *    也不在这里上报外部服务 —— 错误处理路径再失败一次，会把"一个错误"变成两个。
 */

import { useEffect } from 'react';

export default function RouteError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  useEffect(() => {
    console.error('[route error]', error);
  }, [error]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>这个页面没能加载出来</h1>
        <p>你的数据没有丢失 —— 所有状态都在事件流里，刷新或重试即可。</p>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <button type="button" className="btn btn-primary btn-sm" onClick={reset}>
            重试
          </button>
          <a className="btn btn-sm" href="/">
            回到对话
          </a>
        </div>

        <details>
          <summary className="small muted">技术细节</summary>
          <pre
            style={{
              margin: '8px 0 0',
              padding: '10px 12px',
              background: 'var(--bg-soft)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message.length > 0 ? error.message : '（无信息）'}
            {error.digest !== undefined ? `\ndigest: ${error.digest}` : ''}
          </pre>
        </details>
      </div>
    </div>
  );
}
