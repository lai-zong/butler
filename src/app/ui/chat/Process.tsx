'use client';

/**
 * 过程面板 —— 「思考 → 工具 → 再思考」的可见化
 *
 * ★ 它是「可审计」在对话现场的第一落点：
 *   用户不需要相信管家的自述，展开就能看到它调了什么、结果是什么。
 *
 * 两种数据源共用同一套渲染：
 *   · 流式中的 LiveRound（逐片到达）
 *   · 刷新后从事件重放出的 AgentTrace（已持久化）
 */

import { useEffect, useRef, useState } from 'react';

import { Badge, Collapse } from '../components/Common';
import { Icon } from '../components/Icon';
import { CLASS_LABEL, formatDuration, truncate } from '../lib/format.js';
import type { InjectedConstraintView, LiveToolStatus } from '../lib/types.js';

export interface ProcTool {
  readonly callId: string;
  readonly name: string;
  readonly argsText: string;
  readonly status: LiveToolStatus;
  readonly output: string;
  readonly durationMs: number | null;
}

export interface ProcRound {
  readonly round: number;
  readonly maxRounds: number;
  readonly reasoning: string;
  readonly text: string;
  readonly tools: readonly ProcTool[];
}

interface ProcessPanelProps {
  readonly rounds: readonly ProcRound[];
  readonly stages?: readonly string[];
  readonly narration?: string;
  readonly narrationReasoning?: string;
  readonly narrationTranslated?: string;
  readonly firstChunkMs?: number | null;
  readonly finished?: { readonly rounds: number; readonly hitRoundLimit: boolean; readonly reason: string } | null;
  readonly streaming?: boolean;
  readonly defaultOpen?: boolean;
  readonly durationMs?: number | null;
  readonly injectedConstraints?: readonly InjectedConstraintView[];
}

const REASON_LABEL: Record<string, string> = {
  noToolCalls: '直接作答',
  terminalTool: '提交了结果',
  roundLimit: '达到轮次上限',
};

const TOOL_STATUS: Record<LiveToolStatus, { label: string; cls: string }> = {
  pending: { label: '等待', cls: 'pending' },
  running: { label: '执行中', cls: 'running' },
  ok: { label: '成功', cls: 'ok' },
  denied: { label: '被拒绝', cls: 'denied' },
  error: { label: '失败', cls: 'error' },
};

function ToolIcon({ status }: { readonly status: LiveToolStatus }): JSX.Element {
  if (status === 'running') return <Icon name="refresh" size={13} className="spin" />;
  if (status === 'ok') return <Icon name="check" size={13} />;
  if (status === 'denied') return <Icon name="shield" size={13} />;
  if (status === 'error') return <Icon name="alert" size={13} />;
  return <Icon name="clock" size={13} />;
}

export function ProcessPanel({
  rounds,
  stages = [],
  narration = '',
  narrationReasoning = '',
  narrationTranslated = '',
  firstChunkMs = null,
  finished = null,
  streaming = false,
  defaultOpen = false,
  durationMs = null,
  injectedConstraints = [],
}: ProcessPanelProps): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);
  const touched = useRef(false);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (streaming && !touched.current) setOpen(true);
    // 完成时自动收起过程：最终视图应该先看见答案，而不是一长串工具日志。
    // 用户手动展开过（touched）则尊重他的选择，不再自动收起。
    if (wasStreaming.current && !streaming && !touched.current) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  const toolCount = rounds.reduce((n, r) => n + r.tools.length, 0);
  const hasAny =
    rounds.length > 0 ||
    stages.length > 0 ||
    narration.length > 0 ||
    narrationReasoning.length > 0 ||
    narrationTranslated.length > 0 ||
    injectedConstraints.length > 0;

  if (!hasAny && !streaming) return null;

  const summary = streaming
    ? stages[stages.length - 1] ?? (rounds.length > 0 ? `第 ${rounds.length} 轮` : '正在处理')
    : [
        rounds.length > 0 ? `${rounds.length} 轮` : '',
        toolCount > 0 ? `${toolCount} 次工具` : '',
        finished !== null ? REASON_LABEL[finished.reason] ?? finished.reason : '',
        durationMs !== null && durationMs > 0 ? formatDuration(durationMs) : '',
      ]
        .filter((x) => x.length > 0)
        .join(' · ');

  return (
    <section className={`process ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="process-head"
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className="process-title">
          <span className={`process-pulse ${streaming ? 'is-live' : ''}`} aria-hidden="true" />
          过程
        </span>
        <span className="process-summary">{summary}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} className="process-chevron" />
      </button>

      <Collapse open={open}>
        <div className="process-body">
          {stages.length > 0 && (
            <ol className="stage-trail" aria-label="阶段">
              {stages.map((s, i) => (
                <li key={`${s}-${i}`} className={i === stages.length - 1 && streaming ? 'is-current' : ''}>
                  <span className="stage-dot" aria-hidden="true" />
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}

          {narration.length > 0 && (
            <div className="proc-block proc-narration">
              <div className="proc-block-head">
                <span>先说思路</span>
                {firstChunkMs !== null && firstChunkMs > 0 && (
                  <small className="mono">首字 {Math.round(firstChunkMs)} ms</small>
                )}
              </div>
              <p>{narration}</p>
            </div>
          )}

          {narrationReasoning.length > 0 || narrationTranslated.length > 0 ? (
            <ReasoningBlock
              text={narrationReasoning.length > 0 ? narrationReasoning : narrationTranslated}
              translated={narrationTranslated}
              label="叙述的思考"
            />
          ) : null}

          {rounds.map((r) => (
            <RoundView key={r.round} round={r} />
          ))}

          {finished !== null && (
            <div className="proc-finished">
              <Icon name={finished.hitRoundLimit ? 'alert' : 'checkCircle'} size={14} />
              <span>
                {finished.hitRoundLimit
                  ? `达到 ${finished.rounds} 轮上限，已停止继续调用`
                  : `循环结束 · ${REASON_LABEL[finished.reason] ?? finished.reason}`}
              </span>
            </div>
          )}

          {injectedConstraints.length > 0 && (
            <div className="proc-block proc-constraints">
              <div className="proc-block-head">
                <span>注入的约束</span>
                <small className="mono">{injectedConstraints.length}</small>
              </div>
              <ul>
                {injectedConstraints.map((c, i) => (
                  <li key={`${c.memoryId ?? 'c'}-${i}`}>
                    <Badge tone={c.negotiable ? 'neutral' : 'accent'}>
                      {CLASS_LABEL[c.source as keyof typeof CLASS_LABEL] ?? c.source}
                    </Badge>
                    <span>{c.content}</span>
                    {!c.negotiable && <small>不可协商</small>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Collapse>
    </section>
  );
}

function RoundView({ round }: { readonly round: ProcRound }): JSX.Element {
  const [openTool, setOpenTool] = useState<string | null>(null);

  return (
    <div className="proc-round">
      <div className="proc-round-head">
        <span className="proc-round-label">第 {round.round} 轮</span>
        {round.maxRounds > 0 && <span className="proc-round-limit">上限 {round.maxRounds}</span>}
      </div>

      {round.reasoning.length > 0 && <ReasoningBlock text={round.reasoning} label="思考" />}

      {round.tools.length > 0 && (
        <ul className="tool-list">
          {round.tools.map((tool) => {
            const status = TOOL_STATUS[tool.status];
            const isOpen = openTool === tool.callId;
            return (
              <li key={tool.callId} className={`tool tool--${status.cls}`}>
                <button
                  type="button"
                  className="tool-head"
                  onClick={() => setOpenTool(isOpen ? null : tool.callId)}
                  aria-expanded={isOpen}
                >
                  <span className="tool-status">
                    <ToolIcon status={tool.status} />
                  </span>
                  <span className="tool-name mono">{tool.name.length > 0 ? tool.name : '工具调用'}</span>
                  {tool.argsText.length > 0 && (
                    <span className="tool-args mono">{truncate(tool.argsText, 64)}</span>
                  )}
                  <span className="tool-meta">
                    {tool.durationMs !== null && <span className="mono">{formatDuration(tool.durationMs)}</span>}
                    <span className={`tool-state tool-state--${status.cls}`}>{status.label}</span>
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
                  </span>
                </button>
                <Collapse open={isOpen}>
                  <div className="tool-detail">
                    {tool.argsText.length > 0 && (
                      <div>
                        <p className="tool-detail-label">参数</p>
                        <pre className="code-block">{tool.argsText}</pre>
                      </div>
                    )}
                    <p className="tool-detail-label">结果</p>
                    <pre className="code-block tool-output">
                      {tool.output.length > 0 ? tool.output : '（没有返回内容）'}
                    </pre>
                  </div>
                </Collapse>
              </li>
            );
          })}
        </ul>
      )}

      {round.text.length > 0 && <p className="proc-round-text">{round.text}</p>}
    </div>
  );
}

function ReasoningBlock({
  text,
  translated = '',
  label,
}: {
  readonly text: string;
  readonly translated?: string;
  readonly label: string;
}): JSX.Element {
  const [language, setLanguage] = useState<'zh' | 'en'>(translated.length > 0 ? 'zh' : 'en');
  const [expanded, setExpanded] = useState(false);
  const shown = language === 'zh' && translated.length > 0 ? translated : text;
  const canToggle = translated.length > 0 && text.length > 0 && translated !== text;

  return (
    <div className="reasoning">
      <div className="reasoning-head">
        <span className="reasoning-label">
          <Icon name="sparkle" size={12} /> {label}
        </span>
        <span className="reasoning-actions">
          {canToggle && (
            <span className="seg">
              <button
                type="button"
                className={language === 'zh' ? 'is-active' : ''}
                onClick={() => setLanguage('zh')}
              >
                译文
              </button>
              <button
                type="button"
                className={language === 'en' ? 'is-active' : ''}
                onClick={() => setLanguage('en')}
              >
                原文
              </button>
            </span>
          )}
        </span>
      </div>
      <div className={`reasoning-text ${expanded ? 'is-expanded' : ''}`}>{shown}</div>
      {shown.length > 280 && (
        <button type="button" className="text-btn reasoning-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}
