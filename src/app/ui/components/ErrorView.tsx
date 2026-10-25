'use client';

/**
 * 全局错误边界共用的可读界面。
 *
 * ⚠️ 不展示 error.message：它可能包含路径、工具输出或外部内容。
 *    只显示“发生了什么 + 数据仍然在本地 + 可以重试/回首页”。
 */

interface ErrorViewProps {
  readonly reset: () => void;
  readonly digest?: string;
}

export function ErrorView({ reset, digest }: ErrorViewProps): JSX.Element {
  return (
    <main className="error-screen" role="alert">
      <div className="error-mark" aria-hidden="true">!</div>
      <p className="error-kicker">BUTLER / RECOVERY</p>
      <h1>这次界面没能继续</h1>
      <p className="error-lead">
        你的记忆、对话与事件仍然保存在这台电脑上。可以重试；如果还是不行，回到首页重新进入。
      </p>
      {digest !== undefined && digest.length > 0 && (
        <p className="error-digest mono">错误编号：{digest}</p>
      )}
      <div className="error-actions">
        <button type="button" className="error-btn error-btn-primary" onClick={reset}>
          重试
        </button>
        <a className="error-btn" href="/">
          回到首页
        </a>
      </div>
      <p className="error-foot">没有上传任何数据；本地事件流没有被清空。</p>
    </main>
  );
}
