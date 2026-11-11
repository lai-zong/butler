'use client';

/**
 * Markdown 渲染
 *
 * ★ 用 react-markdown（默认不渲染原始 HTML）—— 模型输出是不可信内容，
 *   “不执行 HTML”必须是默认行为，而不是靠调用方记得关掉。
 *
 * ★ 为什么要 memo：这个组件挂在聊天长列表里，而列表在流式输出时大约每
 *   48ms 重新渲染一次。父组件一重渲染，整段 Markdown 就会重新走一遍
 *   remark 解析并重建 React 树；可历史消息的 text 根本没变，这些计算全是白做。
 *   memo 默认的浅比较对当前 props（string / boolean）正合适。
 *
 * ★ 注意：现在 props 只有值类型，所以 memo 能真正命中；**将来若给这个组件
 *   加回调或对象类型的 props，调用方必须传稳定引用**（useCallback / useMemo），
 *   否则每次父渲染都是新引用，memo 会静默失效——这不是本组件能替调用方解决的。
 */

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function MarkdownView({
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

export const Markdown = memo(MarkdownView);

// memo 返回的是对象而不是普通函数，React DevTools 里默认只会显示 Memo(...)；
// 显式起名能在性能面板里一眼认出是哪段 Markdown 触发的重渲染。
Markdown.displayName = 'Markdown';
