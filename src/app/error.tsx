'use client';

/**
 * 路由级错误兜底（Next.js App Router 约定）。
 *
 * ★ 与 `app/app/error-boundary.tsx` 的分工：
 *   · **组件级边界**（`AppErrorBoundary`）兜住"某一块渲染失败" —— 首选，因为范围小
 *   · **路由级 error.tsx**（本文件）兜住"整页都没渲染出来" —— 最后一道
 *
 * ⚠️ 为什么两层都要有：
 *   组件级边界只能捕获**子树渲染期**的错误。以下三种它抓不到：
 *     ① 边界自身渲染时抛错
 *     ② `layout.tsx` 渲染期抛错
 *     ③ 服务端组件（RSC）在流式传输中抛错
 *   这些只能由 Next 的 `error.tsx` 接住。
 *
 * ⚠️ 本文件**不能**用 `export const runtime = 'nodejs'` 之外的花样：
 *    Next 要求 error.tsx 必须是客户端组件，且不能是 async。
 */

import { useEffect } from 'react';

export default function RouteError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  /**
   * 完整错误只进控制台 —— 界面上不给用户看堆栈。
   * ⚠️ 也不要在这里上报到外部服务：错误处理路径里再加一个可能失败的动作，
   *    会把"一个错误"变成"两个错误"。
   */
  useEffect(() => {
    console.error('[route error]', error);
  }, [error]);

  return (
    <div className="nv-row" role="alert" data-route-error>
      <span className="nv-note-warn">这个页面没能加载出来。你的数据没有丢失。</span>
      <button type="button" className="nv-iconbtn" onClick={reset}>
        重试
      </button>
      <details>
        <summary className="nv-note">技术细节</summary>
        <div className="nv-mono">
          {error.message.length > 0 ? error.message : '（无信息）'}
          {error.digest !== undefined ? ` · digest ${error.digest}` : ''}
        </div>
      </details>
    </div>
  );
}
