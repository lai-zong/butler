/**
 * 新版界面 · 仆人窗口（右栏）
 *
 * ★★ 三个用户明确的要求，这里是它们的落点：
 *
 *   ① 「仆人窗口应该与管家窗口**一模一样**，而不是分产出、发现等等内容」
 *      → 结构完全一致：**先过程（可折叠）→ 再最终回复**。
 *        过程用与管家同一个组件（`ProcessView`），
 *        回复用同一套类名（`nv-msg` / `nv-msg-role` / `nv-msg-text`）。
 *
 *   ② 「像 dsh 一样：先流式输出思考内容、工具调用，
 *       这些结束后，再输出最终回复」
 *      → 顺序就是过程在前、回复在后（与管家那条消息一样）。
 *
 *   ③ 「所有对话窗口，包括管家和仆人，都支持**直接对话**」
 *      → 右栏底部有真输入框，**能发出去、有回复**（不是留位）。
 *        规则（用户定的）：
 *          · 直接找仆人时**不派发、不验收** ——
 *            用户说什么，仆人就直接做什么
 *          · 管家只能在事后提醒，**不得截断仆人进程**
 *          · ⚠️ 但硬约束照样注入、权限闸门照样生效 ——
 *            「不拦截」讲的是**流程**，不是安全底线让步
 *
 * ★ 多窗口排布：**默认标签页 + 可切并排**（用户选的）。
 */

'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RichContent } from '../rich-content.js';
import type { ServantOut } from './conversation.js';
import { ProcessView, type TraceView } from './process.js';
import { Dot, Row, Sep, SERVANT_NAME, SERVANT_STATUS, Tag } from './ui.js';

// ═══════════════════════════════════════════════════════════
// 右栏
// ═══════════════════════════════════════════════════════════

/** 一个仆人窗口里的一条消息。 */
export interface PaneMsg {
  readonly id: string;
  readonly role: 'user' | 'servant';
  readonly text: string;
  readonly trace?: TraceView;
  readonly status?: string;
}

export function ServantPane({
  reports,
  busy,
  history,
  onSend,
}: {
  /** 本轮各仆人的产出（来自 `/api/chat` 的 `reports` 事件） */
  readonly reports: readonly ServantOut[];
  readonly busy: boolean;
  /** 直接对话的历史（按仆人分） */
  readonly history: Readonly<Record<string, readonly PaneMsg[]>>;
  /** 直接对某个仆人发消息 */
  readonly onSend: (servant: string, text: string) => void;
}): ReactNode {
  const [active, setActive] = useState<string>('');
  /** ⚠️ 用户选的方案：「默认标签页 + 可切并排」 */
  const [sideBySide, setSideBySide] = useState(false);

  /**
   * 有哪些仆人可看 —— **本轮出现的** ∪ **有历史的**。
   *
   * ⚠️ 只取本轮会出现一个问题：聊完一轮后切到「记忆」页再回来，
   *    本轮 reports 被清空 → 窗口列表空了 → 刚才跟仆人说的话也不见了。
   *    所以要把有历史的也算上。
   */
  const servants = useMemo(() => {
    const set = new Set<string>();
    for (const r of reports) set.add(r.servant);
    for (const [k, v] of Object.entries(history)) {
      if (v.length > 0) set.add(k);
    }
    // 稳定顺序（否则标签页会跳来跳去）
    return [...set].sort();
  }, [reports, history]);

  // 选中项失效时兜底回第一个
  const cur = servants.includes(active) ? active : (servants[0] ?? '');

  if (servants.length === 0) return null;

  return (
    <>
      <div className="nv-pane-head">
        <span className="nv-pane-title">仆人</span>
        {busy && <Dot state="run" />}
        <span style={{ flex: 1 }} />
        {servants.length > 1 && (
          <button
            type="button"
            className="nv-btn"
            style={{ height: 26, padding: '0 10px', fontSize: 'var(--n-fs-cap)' }}
            onClick={() => setSideBySide((v) => !v)}
            title={sideBySide ? '切回单个查看' : '并排对比'}
          >
            {sideBySide ? '单个' : '并排'}
          </button>
        )}
      </div>

      {sideBySide ? (
        <div className="nv-panes">
          {servants.map((s) => (
            <div className="nv-pane" key={s}>
              <div className="nv-pane-name">
                <Dot state={dotOf(statusOf(reports, s))} />
                {SERVANT_NAME[s] ?? s}
              </div>
              <ServantWindow
                servant={s}
                report={reports.find((r) => r.servant === s)}
                msgs={history[s] ?? []}
                busy={busy}
                onSend={onSend}
                compact
              />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="nv-tabs" role="tablist">
            {servants.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === cur}
                className="nv-tab"
                data-on={s === cur ? '' : undefined}
                onClick={() => setActive(s)}
              >
                <Dot state={dotOf(statusOf(reports, s))} />
                {SERVANT_NAME[s] ?? s}
              </button>
            ))}
          </div>
          <ServantWindow
            servant={cur}
            report={reports.find((r) => r.servant === cur)}
            msgs={history[cur] ?? []}
            busy={busy}
            onSend={onSend}
          />
        </>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 一个仆人的窗口
// ═══════════════════════════════════════════════════════════

function ServantWindow({
  servant,
  report,
  msgs,
  busy,
  onSend,
  compact = false,
}: {
  readonly servant: string;
  readonly report: ServantOut | undefined;
  readonly msgs: readonly PaneMsg[];
  readonly busy: boolean;
  readonly onSend: (servant: string, text: string) => void;
  readonly compact?: boolean;
}): ReactNode {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // ⚠️ 自动滚底但**用户上翻时暂停** —— 正在往回读时被拽到底最恼人
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  useEffect(() => {
    if (!pinned.current) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [msgs, report]);

  const send = useCallback(() => {
    const t = input.trim();
    if (t.length === 0 || busy) return;
    setInput('');
    pinned.current = true;
    onSend(servant, t);
  }, [input, busy, onSend, servant]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  const empty = msgs.length === 0 && report === undefined;

  return (
    <>
      <div className="nv-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="nv-scroll-inner">
          {empty && (
            <div className="nv-empty" style={{ padding: '40px var(--n-sp-3)' }}>
              <div className="nv-empty-title">还没有跟它说过话</div>
              <div className="nv-empty-sub">
                在下面直接说就行。它不会经管家派发，
                但会先把你的话记住，并遵守你已经定下的硬性要求。
              </div>
            </div>
          )}

          {/* ① 直接对话的历史（用户↔仆人） */}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div className="nv-msg nv-msg-user" key={m.id}>
                <div className="nv-msg-body">{m.text}</div>
              </div>
            ) : (
              <div className="nv-msg" key={m.id}>
                {m.trace !== undefined && m.trace.rounds.length > 0 && (
                  <ProcessView trace={m.trace} />
                )}
                <div className="nv-msg-role">
                  {SERVANT_NAME[servant] ?? servant}
                  {m.status !== undefined && (
                    <>
                      <Sep />
                      <Tag tone={m.status === 'done' ? 'quiet' : 'warn'}>
                        {SERVANT_STATUS[m.status] ?? m.status}
                      </Tag>
                    </>
                  )}
                </div>
                <div className="nv-msg-text">
                  <RichContent text={m.text} />
                </div>
              </div>
            ),
          )}

          {/* ② 管家派发给它的那一轮（与本轮 reports 对应） */}
          {report !== undefined && (
            <div className="nv-msg">
              <div className="nv-msg-role">
                <span style={{ color: 'var(--n-text-faint)' }}>管家派来的任务</span>
              </div>
              {report.agentTrace !== undefined && report.agentTrace.rounds.length > 0 && (
                <ProcessView trace={report.agentTrace} />
              )}
              {report.reply.trim().length > 0 ? (
                <div className="nv-msg-text">
                  <RichContent text={report.reply} />
                </div>
              ) : (
                /* ⚠️ 没有 reply 时**如实说明**，不显示空白 ——
                   空白会让用户以为界面坏了。
                   （旧数据里确实没这个字段，见 `core/chat/parse.ts`。） */
                <div className="nv-note">
                  这次它没有留下说明。可以点开下面的「细节」看它做了什么。
                </div>
              )}
              <Details report={report} />
            </div>
          )}

          {/* ③ 正在执行 */}
          {busy && msgs.length > 0 && msgs[msgs.length - 1]?.role === 'user' && (
            <Row
              leading={<Dot state="run" />}
              label={<span className="nv-shimmer">它正在做事…</span>}
            />
          )}
        </div>
      </div>

      {/* ── 真输入框（能发出去、有回复，不是留位）── */}
      <div className="nv-composer" style={compact ? { padding: 'var(--n-sp-2)' } : undefined}>
        <div className="nv-inputrow">
          <textarea
            className="nv-input"
            rows={1}
            value={input}
            disabled={busy}
            placeholder={busy ? '正在执行…' : `直接对${SERVANT_NAME[servant] ?? '仆人'}说…`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <button
            type="button"
            className="nv-btn nv-btn-primary"
            disabled={busy || input.trim().length === 0}
            onClick={send}
          >
            发送
          </button>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 细节（默认收起）
// ═══════════════════════════════════════════════════════════

/**
 * 产出 / 发现 / 不确定 / 待裁决。
 *
 * ⚠️ 标题写「细节」而不是「产出」：
 *    「产出」听起来像主内容，而主内容已经是上面那段话了。
 * ⚠️ 保留但收起（不是删除）：它是「可审计」的落点，
 *    用户要核对"清单里到底写了什么"必须查得到。
 */
function Details({ report }: { readonly report: ServantOut }): ReactNode {
  const [open, setOpen] = useState(false);

  const counts: string[] = [];
  if (report.artifacts.length > 0) counts.push(`${report.artifacts.length} 项产出`);
  if (report.findings.length > 0) counts.push(`${report.findings.length} 条发现`);
  if (report.uncertainties.length > 0) counts.push(`${report.uncertainties.length} 条不确定`);
  if (report.needsButlerDecision !== undefined) counts.push('1 项待裁决');

  if (counts.length === 0) return null;

  return (
    <div className="nv-proc" data-open={open ? 'true' : undefined}>
      <Row
        caret={open ? '▾' : '▸'}
        label={
          <>
            细节
            <Sep />
            <span style={{ color: 'var(--n-text-faint)' }}>{counts.join(' · ')}</span>
          </>
        }
        onClick={() => setOpen((v) => !v)}
        open={open}
      />
      {open && (
        <div>
          {report.artifacts.map((a, i) => (
            <ArtifactBlock key={i} kind={a.kind} text={a.text} itemCount={a.itemCount} />
          ))}

          {report.findings.length > 0 && (
            <div className="nv-sub">
              {report.findings.map((f, i) => (
                <FindingBlock key={i} finding={f} />
              ))}
            </div>
          )}

          {report.uncertainties.length > 0 && (
            <div className="nv-sub">
              {report.uncertainties.map((u, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 'var(--n-fs-cap)',
                    color: 'var(--n-text-sub)',
                    padding: 'var(--n-sp-1) 0',
                  }}
                >
                  · {u}
                </div>
              ))}
            </div>
          )}

          {report.needsButlerDecision !== undefined && (
            <div className="nv-note nv-note-warn" style={{ marginLeft: 15 }}>
              <strong>它请管家裁决：</strong>
              {report.needsButlerDecision}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ARTIFACT_LABEL: Record<string, string> = {
  text: '正文',
  list: '清单',
  plan: '方案',
  file: '文件',
};

function ArtifactBlock({
  kind,
  text,
  itemCount,
}: {
  readonly kind: string;
  readonly text: string;
  readonly itemCount: number;
}): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Row
        caret={open ? '▾' : '▸'}
        label={
          <>
            {ARTIFACT_LABEL[kind] ?? kind}
            {itemCount > 1 && (
              <>
                <Sep />
                <span style={{ color: 'var(--n-text-faint)' }}>{itemCount} 条</span>
              </>
            )}
          </>
        }
        onClick={() => setOpen((v) => !v)}
        open={open}
      />
      {open && <div className="nv-panel">{text}</div>}
    </div>
  );
}

const FINDING_LABEL: Record<string, string> = {
  constraintRef: '约束相关',
  risk: '风险',
  alternative: '备选',
};

function FindingBlock({
  finding,
}: {
  readonly finding: {
    readonly kind: string;
    readonly statement: string;
    readonly evidence: readonly string[];
  };
}): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ padding: 'var(--n-sp-1) 0' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--n-sp-2)' }}>
        <Tag tone={finding.kind === 'risk' ? 'warn' : 'quiet'}>
          {FINDING_LABEL[finding.kind] ?? finding.kind}
        </Tag>
        <span style={{ fontSize: 'var(--n-fs-cap)', color: 'var(--n-text-sub)' }}>
          {finding.statement}
        </span>
      </div>
      {/* ⚠️ 依据入口**常显**（不是隐形箭头）——
          用户反馈过「我没看见在哪里」，根因就是只有隐形箭头。 */}
      {finding.evidence.length > 0 && (
        <>
          <Row
            caret={open ? '▾' : '▸'}
            label={
              <span style={{ color: 'var(--n-text-faint)' }}>
                依据 {finding.evidence.length} 条
              </span>
            }
            onClick={() => setOpen((v) => !v)}
            open={open}
          />
          {open && (
            <div className="nv-panel" style={{ marginLeft: 15 }}>
              {finding.evidence.map((e, i) => (
                <div key={i}>· {e}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════

function statusOf(reports: readonly ServantOut[], servant: string): string {
  return reports.find((r) => r.servant === servant)?.status ?? 'idle';
}

function dotOf(status: string): 'idle' | 'run' | 'ok' | 'fail' | 'deny' {
  if (status === 'done') return 'ok';
  if (status === 'blocked') return 'deny';
  if (status === 'failed') return 'fail';
  return 'idle';
}
