/**
 * 新版界面 · 执行过程
 *
 * ★★ 结构按 dsh 的做法（用户明确要求「像 dsh 一样」）：
 *
 *     ▸ 执行了 2 轮 · 5 次工具调用          ← 收起态**恰好一行**
 *     ─────────────────────────────────
 *     第 1 轮  ·  思考 69 字                 ← 展开后：轮 → 调用 两级
 *       ● 读取文件  冰箱盘点.txt   48 字 · 4ms
 *       ● 写入文件  方案.md        已拒绝
 *       ● 执行命令  cat xxx        失败
 *
 * ★ 五条从 dsh 学来的具体手法（每条都对应我踩过的坑）：
 *
 *   ① **收起态固定一行高**（`contain: size layout`）
 *      ⚠️ 我第一版让过程常驻展开 —— 一轮 8 次调用就是十几行"执行日志"
 *         压在回复上面，用户说"太不简洁"。
 *
 *   ② **工具调用是一行**，不是卡片
 *      ⚠️ 我第一版每次调用一张带边框卡片，8 个调用 = 8 个框。
 *
 *   ③ **过程文字用最弱一级颜色**
 *      ⚠️ 工具名用正文色时，它比模型说的话还抢眼。
 *
 *   ④ **参数压成 `键=值` 短串**，最多 3 个键
 *      ⚠️ 我第一版显示整段 JSON —— 引号括号对用户是纯噪音。
 *
 *   ⑤ **成功只有颜色点，失败/被拒才补词**
 *      ⚠️ 给每次成功都标"成功"是噪音；但失败必须说，
 *         而且只靠颜色的话色盲用户分辨不出。
 */

'use client';

import { type ReactNode, useCallback, useState } from 'react';

import { Dot, type DotState, Fold, Row, Sep, toolWord } from './ui.js';

/** 一次工具调用（与 `core/chat/types.ts` 的落盘形状一致）。 */
export interface ToolCallView {
  readonly callId: string;
  readonly name: string;
  readonly argsText: string;
  readonly ok: boolean;
  readonly denied: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export interface RoundView {
  readonly round: number;
  readonly reasoning: string;
  readonly toolCalls: readonly ToolCallView[];
}

export interface TraceView {
  readonly rounds: readonly RoundView[];
  readonly finished: {
    readonly rounds: number;
    readonly hitRoundLimit: boolean;
    readonly reason: string;
  } | null;
}

const RESULT_PREVIEW = 1200;

export function ProcessView({
  trace,
  live = false,
}: {
  readonly trace: TraceView;
  /** 正在执行中（文字带流光） */
  readonly live?: boolean;
}): ReactNode {
  const calls = trace.rounds.reduce((n, r) => n + r.toolCalls.length, 0);
  const reasoning = trace.rounds.reduce((n, r) => n + r.reasoning.length, 0);
  const f = trace.finished;

  /**
   * 收起态那一行的文字。
   *
   * ★ 用**散文**而不是标签：
   *   「执行了 2 轮 · 5 次工具调用」比「执行过程 [2轮][5次]」好读 ——
   *   后者像仪表盘，前者像人在说话。
   */
  const summary = live
    ? `正在做事…（第 ${trace.rounds.length} 轮）`
    : `执行了 ${f?.rounds ?? trace.rounds.length} 轮 · ${calls} 次操作`;

  return (
    <Fold
      label={<span className={live ? 'nv-shimmer' : undefined}>{summary}</span>}
      {...(reasoning > 0 && !live ? { tail: `思考 ${reasoning} 字` } : {})}
      leading={
        live ? <Dot state="run" /> : <span className="nv-caret" aria-hidden>·</span>
      }
    >
      {trace.rounds.map((r) => (
        <RoundBlock key={r.round} round={r} />
      ))}
      {f?.hitRoundLimit === true && (
        <Row label={<span className="nv-note-warn">达到了操作次数上限，可能没做完</span>} />
      )}
    </Fold>
  );
}

function RoundBlock({ round }: { readonly round: RoundView }): ReactNode {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const hasThinking = round.reasoning.trim().length > 0;

  return (
    <div>
      {/* ── 轮标题：**一行**。有思考时它才是可点的（否则没必要点）── */}
      {hasThinking ? (
        <Row
          caret={open ? '▾' : '▸'}
          label={`第 ${round.round} 轮`}
          tail={`思考 ${round.reasoning.length} 字`}
          onClick={toggle}
          open={open}
          title="展开看它当时的想法"
        />
      ) : (
        <Row
          caret=" "
          label={
            <>
              第 {round.round} 轮
              <Sep />
              {round.toolCalls.length} 次操作
            </>
          }
        />
      )}

      {/* 思考：默认收起（一轮可能几千字，展开会把对话淹掉） */}
      {open && hasThinking && <div className="nv-reasoning">{round.reasoning}</div>}

      {/* ★ 工具调用：**一次一行**，缩进在轮之下 */}
      {round.toolCalls.length > 0 && (
        <div className="nv-sub">
          {round.toolCalls.map((tc) => (
            <ToolRow key={tc.callId} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ call }: { readonly call: ToolCallView }): ReactNode {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const state: DotState = call.denied ? 'deny' : call.ok ? 'ok' : 'fail';
  const args = summarizeArgs(call.argsText);

  return (
    <div>
      <Row
        caret={open ? '▾' : '▸'}
        leading={<Dot state={state} />}
        label={
          <>
            {/* ⚠️ 工具名翻成中文：`read_file` 对大众是噪音 */}
            <span>{toolWord(call.name)}</span>
            {args.length > 0 && (
              <>
                <Sep />
                <span className="nv-mono" style={{ color: 'var(--n-text-faint)' }}>
                  {args}
                </span>
              </>
            )}
          </>
        }
        tail={
          <>
            {/* ⚠️ 失败/被拒**必须给词** —— 只靠颜色色盲用户分辨不出 */}
            {call.denied && <span className="nv-tag nv-tag-danger">已拒绝</span>}
            {!call.denied && !call.ok && <span className="nv-tag nv-tag-warn">失败</span>}
            {call.durationMs > 0 && (
              <span className="nv-mono">{call.durationMs}ms</span>
            )}
          </>
        }
        onClick={toggle}
        open={open}
        title={call.denied ? '这类操作需要你确认，本次没有执行' : '展开看结果'}
      />
      {open && call.output.length > 0 && (
        <div className="nv-panel nv-mono">
          {call.output.length > RESULT_PREVIEW
            ? `${call.output.slice(0, RESULT_PREVIEW)}\n…（共 ${call.output.length} 字）`
            : call.output}
        </div>
      )}
    </div>
  );
}

/**
 * 参数压成 `键=值` 短串。
 *
 * ⚠️ 与旧版的关键差别：**不显示 JSON 符号**。
 *    `{"path":"冰箱盘点.txt"}` 里的引号与花括号对用户是纯噪音，
 *    而 `path=冰箱盘点.txt` 一眼就懂。
 */
function summarizeArgs(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return '';

  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    // ⚠️ 参数是**逐片拼出来的**，流式期间可能残缺 ——
    //    这时**不显示**比显示半截 JSON 好（半截 JSON 会让人以为出错了）
    return '';
  }
  if (typeof v !== 'object' || v === null) return String(v).slice(0, 40);

  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s === undefined) continue;
    parts.push(`${k}=${s.length > 36 ? `${s.slice(0, 36)}…` : s}`);
    if (parts.length >= 2) break; // 最多 2 个键，多了看不完
  }
  return parts.join(' ');
}
