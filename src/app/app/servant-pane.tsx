/**
 * 新版界面 · 仆人窗口（右栏）
 *
 * ★★ 两个用户明确的要求，这里是它们的落点：
 *
 *   ① 「**仆人窗口应该与管家窗口一模一样**，
 *       而不是分产出、发现等等内容」
 *
 *      → 结构完全一致：**先过程（可折叠）→ 再最终回复**。
 *        过程用与管家同一个组件（`ProcessView`），
 *        回复用同一套类名（`nv-msg` / `nv-msg-role` / `nv-msg-text`）。
 *
 *      ⚠️ 我第一版把它做成了**结构化报表**（产出/发现/依据/不确定
 *         各自一栏），用户看到的是报表而不是一个人在说话。
 *         结构化内容**保留但整体收起**（那是"可审计"的落点，不能删）。
 *
 *   ② 「像 dsh 一样：先流式输出思考内容、工具调用，
 *       这些结束后，再输出最终回复」
 *
 *      → 顺序就是过程在前、回复在后（与管家那条消息一样）。
 *
 * ★ 多窗口的排布（用户选的方案）：
 *   · 默认**标签页** —— 一次只显示一个仆人，界面最干净
 *   · 点「并排」可切换成每栏一个 —— 想对比时用
 */

'use client';

import { type ReactNode, useState } from 'react';

import { RichContent } from '../rich-content.js';
import type { ServantOut } from './conversation.js';
import { ProcessView } from './process.js';
import { Dot, Row, Sep, SERVANT_NAME, SERVANT_STATUS, Tag } from './ui.js';

export function ServantPane({
  reports,
  busy,
}: {
  readonly reports: readonly ServantOut[];
  readonly busy: boolean;
}): ReactNode {
  const [active, setActive] = useState(0);
  /** ⚠️ 用户选的方案：「默认标签页 + 可切并排」 */
  const [sideBySide, setSideBySide] = useState(false);

  // ⚠️ 选中项可能越界（新一轮仆人数量变少）—— 兜底回第一条
  const idx = active < reports.length ? active : 0;

  return (
    <aside className="nv-side-pane">
      <div className="nv-pane-head">
        <span className="nv-pane-title">仆人</span>
        {busy && <Dot state="run" />}
        <span style={{ flex: 1 }} />
        {/* 并排开关 —— 只在有两个以上仆人时才有意义 */}
        {reports.length > 1 && (
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
          {reports.map((r) => (
            <div className="nv-pane" key={`${r.servant}_${r.taskId}`}>
              <div className="nv-pane-name">
                <span className={`nv-dot nv-dot-${dotOf(r.status)}`} aria-hidden />
                {SERVANT_NAME[r.servant] ?? r.servant}
              </div>
              <ServantBody report={r} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="nv-tabs" role="tablist">
            {reports.map((r, i) => (
              <button
                key={`${r.servant}_${r.taskId}`}
                type="button"
                role="tab"
                aria-selected={i === idx}
                className="nv-tab"
                data-on={i === idx ? '' : undefined}
                onClick={() => setActive(i)}
              >
                <span className={`nv-dot nv-dot-${dotOf(r.status)}`} aria-hidden />
                {SERVANT_NAME[r.servant] ?? r.servant}
              </button>
            ))}
          </div>
          {reports[idx] !== undefined && <ServantBody report={reports[idx]} />}
        </>
      )}
    </aside>
  );
}

/**
 * 一个仆人的窗口内容 —— **与管家窗口同一套结构**。
 *
 * ⚠️ 顺序不可颠倒：过程在前、回复在后。
 *    这与管家的消息一致（用户明确要求「先流式输出思考…再输出最终回复」）。
 */
function ServantBody({ report }: { readonly report: ServantOut }): ReactNode {
  return (
    <div className="nv-scroll">
      <div className="nv-scroll-inner">
        {/* ① 过程：思考 + 工具调用（与管家同一个组件） */}
        {report.agentTrace !== undefined && report.agentTrace.rounds.length > 0 && (
          <ProcessView trace={report.agentTrace} />
        )}

        {/* ② 仆人说的话 —— 与管家回复同一套渲染 */}
        <div className="nv-msg">
          <div className="nv-msg-role">
            {SERVANT_NAME[report.servant] ?? report.servant}
            <Sep />
            <Tag tone={report.status === 'done' ? 'quiet' : 'warn'}>
              {SERVANT_STATUS[report.status] ?? report.status}
            </Tag>
          </div>
          {report.reply.trim().length > 0 ? (
            <div className="nv-msg-text">
              <RichContent text={report.reply} />
            </div>
          ) : (
            /* ⚠️ 没有 reply 时**如实说明**，而不是显示空白 ——
               空白会让用户以为界面坏了或仆人卡住了。
               （旧数据里确实没有这个字段，见 `core/chat/parse.ts` 的说明。） */
            <div className="nv-note">
              这次它没有留下说明。可以点开下面的「细节」看它做了什么。
            </div>
          )}
        </div>

        {/* ③ 结构化细节：**整体收起** ——
            ⚠️ 保留但收起（不是删除）：它是「可审计」的落点，
               用户要核对"清单里到底写了什么"必须查得到。
               但默认不占视线 —— 主内容已经是上面那段话了。 */}
        <Details report={report} />
      </div>
    </div>
  );
}

/**
 * 细节（产出 / 发现 / 不确定 / 待裁决）。
 *
 * ⚠️ 标题写「细节」而不是「产出」：
 *    「产出」听起来像主内容，而主内容已经是上面那段话了。
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
  const label = ARTIFACT_LABEL[kind] ?? kind;

  return (
    <div>
      <Row
        caret={open ? '▾' : '▸'}
        label={
          <>
            {label}
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
      {/* ⚠️ 依据的入口**必须常显**（不是隐形箭头）——
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

function dotOf(status: string): string {
  if (status === 'done') return 'ok';
  if (status === 'blocked') return 'deny';
  if (status === 'failed') return 'fail';
  return 'idle';
}
