/**
 * 新版界面 · 基础组件
 *
 * ★★ 这些组件是"简洁"的地基，全部围绕一条规则：
 *
 *   > **一行一信息。**
 *
 *   工具调用、记忆条目、发现、设置项 —— 都是**一行**。
 *   没有边框、没有底色、没有常驻按钮。
 *
 * ⚠️ 前因（用户两次反馈"不简洁"）：
 *    我第一版给每次工具调用一张带 border + background + padding 的卡片，
 *    一次循环 8 个调用就是 8 个框，整页全是格子。
 *    dsh 的做法相反：可折叠行高 24px、无边框、无底色，
 *    箭头**悬停才出现**。
 *
 * ⚠️ 但悬停才出现箭头这一条我**用过头过一次**：
 *    用户反馈"依据行我没看见在哪里" —— 因为没有图标、只有隐形箭头时，
 *    用户根本不知道那行能点。
 *    → 所以这里的规则是：**有图标/有形状态时箭头可隐形；
 *      纯文字行必须常显可点的提示。**
 */

'use client';

import { type ReactNode, useCallback, useState } from 'react';

// ═══════════════════════════════════════════════════════════
// 状态点
// ═══════════════════════════════════════════════════════════

export type DotState = 'idle' | 'run' | 'ok' | 'fail' | 'deny';

/**
 * 状态点 —— 10px 槽位内画 6px 圆。
 *
 * ★ 两种状态**不用文字**表达：成功与进行中。
 *   成功是"默认结果"，写个"成功"是噪音；
 *   进行中用一个旋转弧，比"加载中…"更省地方也更不跳眼。
 *
 * ⚠️ 失败与被拒**会补一个词**（由调用方决定）——
 *    因为那两种情况用户必须知道，不能只靠颜色。
 *    只靠颜色还有一个问题：色盲用户分辨不出。
 */
export function Dot({ state }: { readonly state: DotState }): ReactNode {
  return <span className={`nv-dot nv-dot-${state}`} aria-hidden />;
}

// ═══════════════════════════════════════════════════════════
// 一行
// ═══════════════════════════════════════════════════════════

/**
 * 一行（可折叠或纯展示）。
 *
 * ⚠️ 刻意**不做成带边框的卡片** —— 那是我第一版的错误。
 *    一次界面里几十行，每行一个框就完全没有呼吸感。
 */
export function Row({
  caret,
  leading,
  label,
  tail,
  onClick,
  open,
  title,
}: {
  /** 行首箭头（可折叠时给） */
  readonly caret?: ReactNode;
  /** 行首其它内容（状态点、图标） */
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  /** 行尾（推到最右） */
  readonly tail?: ReactNode;
  readonly onClick?: () => void;
  readonly open?: boolean;
  readonly title?: string;
}): ReactNode {
  const content = (
    <>
      {caret !== undefined && (
        <span className="nv-caret" aria-hidden>
          {caret}
        </span>
      )}
      {leading}
      <span className="nv-row-label">{label}</span>
      {tail !== undefined && <span className="nv-row-tail">{tail}</span>}
    </>
  );

  if (onClick === undefined) {
    return (
      <div className="nv-row" title={title}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="nv-row nv-row-click"
      onClick={onClick}
      aria-expanded={open}
      data-open={open === true ? 'true' : undefined}
      title={title}
    >
      {content}
    </button>
  );
}

/** 2px 分隔点。⚠️ 不用「·」字符 —— 字体不同会没对齐。 */
export function Sep(): ReactNode {
  return <span className="nv-sep" aria-hidden />;
}

// ═══════════════════════════════════════════════════════════
// 折叠组
// ═══════════════════════════════════════════════════════════

/**
 * 可折叠组。
 *
 * ★ 收起时**不挂载内容**（不是用 CSS 隐藏）——
 *   一次工具循环可能有几千字思考 + 几十 KB 结果，
 *   CSS 隐藏仍会进 DOM，长对话下内存与渲染都会拖慢。
 */
export function Fold({
  label,
  tail,
  defaultOpen = false,
  children,
  leading,
}: {
  readonly label: ReactNode;
  readonly tail?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
  readonly leading?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="nv-proc" data-open={open ? 'true' : undefined}>
      <Row
        caret={open ? '▾' : '▸'}
        leading={leading}
        label={label}
        onClick={toggle}
        open={open}
        {...(tail !== undefined ? { tail } : {})}
      />
      {open && children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 标签
// ═══════════════════════════════════════════════════════════

export type TagTone = 'quiet' | 'ok' | 'warn' | 'danger' | 'accent';

export function Tag({
  tone = 'quiet',
  children,
}: {
  readonly tone?: TagTone;
  readonly children: ReactNode;
}): ReactNode {
  return <span className={`nv-tag nv-tag-${tone}`}>{children}</span>;
}
// ═══════════════════════════════════════════════════════════
// 人话映射 —— 见 `labels.ts`
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 这些映射**不放在本文件**，而是 `labels.ts`。
 *
 *   原因：本文件有 `'use client'`，而那个标记是**模块级**的 ——
 *   它把文件里的一切（包括普通函数与常量）都划给客户端，
 *   于是**服务端组件调用它们会直接报错**：
 *
 *     ⨯ Attempted to call fitnessTone() from the server
 *       but fitnessTone is on the client.
 *
 *   ★ 规律：**纯数据与纯函数不要放进带 `'use client'` 的文件。**
 *     这里只 re-export，方便调用方一处导入；
 *     真正的定义在 `labels.ts`（无 `'use client'`，两边都能用）。
 */
export {
  fitnessTone,
  fitnessWord,
  MEMORY_KIND,
  MEMORY_STATE,
  SERVANT_NAME,
  SERVANT_STATUS,
  TOOL_WORD,
  toolWord,
  VERDICT_WORD,
} from './labels.js';