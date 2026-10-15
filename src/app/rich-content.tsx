/**
 * 内容渲染 —— 把模型产出按排版层次输出
 *
 * 设计依据：用户反馈
 *   「输出的文字排版太密集了……【菜单】可以标粗标大、
 *     "能量估算"可以标粗不标大。总的来说是为了让用户看着舒适，
 *     看得清晰易懂，而不是麻木地将文字打印出来。」
 *
 * ★ 为什么从 `conversation-view.tsx` 里抽出来：
 *   ① 排版效果**需要单独预览**才能调（见 `/typography-preview`）——
 *      埋在对话组件里就没法只渲染一段文本看效果
 *   ② 层次判定（`typography.ts`）与层次渲染（本文件）是一对，
 *      应该挨着放，而不是一个在这里一个在对话组件里
 *
 * ⚠️ 刻意**不用 `dangerouslySetInnerHTML`** ——
 *    产出全部来自我们自己的模型，但仍按纯文本处理，
 *    从根本上没有注入面。层次靠「元素类型 + 类名」，不靠 HTML 字符串拼接。
 */

import { classifyLines } from './typography';

export function RichContent({ text }: { readonly text: string }) {
  const lines = classifyLines(text);

  return (
    <div className="content">
      {lines.map((line, i) => {
        switch (line.kind) {
          case 'blank':
            // ⚠️ 空行不靠 <br> 撑，靠相邻元素的下边距 ——
            //    否则"空行几个"会直接决定疏密，而模型给的空行数不可控。
            //    排版不该交给模型的心情。
            return null;

          case 'divider':
            return <hr className="content-divider" key={i} />;

          case 'major':
            return (
              <div className="content-block" key={i}>
                <div className="content-major">{line.text}</div>
                {line.rest !== undefined && <div className="content-body">{line.rest}</div>}
              </div>
            );

          case 'minor':
            return (
              <div className="content-block" key={i}>
                <div className="content-minor">{line.text}</div>
                {line.rest !== undefined && <div className="content-body">{line.rest}</div>}
              </div>
            );

          case 'list':
            // ── 字段清单：标签 + 逐项一行 ──
            //
            // ★ 「生鲜：鲜虾400g、牛里脊300g、…」拆开后每项独占一行。
            //   这是整段内容里最容易显密的地方 —— 按普通段落渲染会折成
            //   两三行、每行塞满，扫不动。
            if (line.items !== undefined) {
              return (
                <div className="content-block" key={i}>
                  <div className="content-minor">{line.text}</div>
                  <div className="content-field-items">
                    {line.items.map((item, n) => (
                      <div className="content-field-item" key={n}>
                        <Inline text={item} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <div className="content-item" key={i}>
                <span className="content-bullet">
                  {line.listNumber !== undefined ? `${line.listNumber}.` : '·'}
                </span>
                <span className="content-item-text">
                  <Inline text={line.text} />
                </span>
              </div>
            );

          case 'body':
            return (
              <div className="content-body content-block" key={i}>
                <Inline text={line.text} />
              </div>
            );
        }
      })}
    </div>
  );
}

/** 行内加粗（`**x**`）。 */
function Inline({ text }: { readonly text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
