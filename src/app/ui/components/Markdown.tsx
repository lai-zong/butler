'use client';

/**
 * Markdown 渲染
 *
 * ★ 用 react-markdown（默认不渲染原始 HTML）—— 模型输出是不可信内容，
 *   “不执行 HTML”必须是默认行为，而不是靠调用方记得关掉。
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({
  text,
  streaming = false,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}): JSX.Element {
  return (
    <div className={`md ${streaming ? 'is-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="md-caret" aria-hidden="true" />}
    </div>
  );
}
