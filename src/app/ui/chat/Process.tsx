'use client';

/**
 * 过程面板 —— 「思考 → 工具 → 再思考」的可见化
 *
 * ★ 它是「可审计」在对话现场的第一落点：
 *   用户不需要相信管家的自述，展开就能看到它调了什么、结果是什么。
 *
 * ★ v10.3：改成 DSH 式的一行一条。
 *   · 执行中：每来一行就展示一行（思考显示部分内容，工具显示动作与目标）；
 *   · 完成：自动收起为摘要（思考次数 / 工具次数 / 构成 / 用时 / 结果与异常）；
 *   · 不再出现“轮次 / 上限”这类内部执行约束的措辞。
 *
 * 两种数据源共用同一套渲染：
 *   · 流式中的 LiveRound（逐片到达）
 *   · 刷新后从事件重放出的 AgentTrace（已持久化）
 */

import { useEffect, useRef, useState } from 'react';

import { Badge, Collapse } from '../components/Common';
import { Icon } from '../components/Icon';
import { formatDuration, formatTokens } from '../lib/format.js';
import type { InjectedConstraintView, LiveUsage } from '../lib/types.js';
import {
  buildProcessView,
  describeTool,
  previewText,
  type ProcFinished,
  type ProcLine,
  type ProcRound,
  type ProcTool,
  type ProcessStats,
} from './processView';

export type { ProcFinished, ProcRound, ProcTool } from './processView';

interface ProcessPanelProps {
  readonly rounds: readonly ProcRound[];
  readonly stages?: readonly string[];
  readonly narration?: string;
  readonly narrationReasoning?: string;
  readonly narrationTranslated?: string;
  readonly firstChunkMs?: number | null;
  readonly finished?: ProcFinished | null;
  readonly streaming?: boolean;
  readonly defaultOpen?: boolean;
  readonly durationMs?: number | null;
  readonly injectedConstraints?: readonly InjectedConstraintView[];
  /** 本轮/会话累计 token 用量；旧消息没有该数据时为 null。 */
  readonly usage?: LiveUsage | null;
}

const TOOL_STATUS_LABEL: Record<ProcTool['status'], string> = {
  pending: '等待',
  running: '执行中',
  ok: '成功',
  denied: '被拒绝',
  error: '失败',
};

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
  usage = null,
}: ProcessPanelProps): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen || streaming);
  const [expanded, setExpanded] = useState<string | null>(null);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (streaming) setOpen(true);
    // 执行完成、开始输出结果时收起过程；用户想回看再点摘要。
    else if (wasStreaming.current) {
      setOpen(false);
      setExpanded(null);
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  const view = buildProcessView({ rounds, finished, durationMs, streaming });
  const { stats, lines } = view;

  const hasAny =
    lines.length > 0 ||
    stages.length > 0 ||
    narration.length > 0 ||
    narrationReasoning.length > 0 ||
    narrationTranslated.length > 0 ||
    injectedConstraints.length > 0 ||
    usage !== null;

  if (!hasAny && !streaming) return null;

  return (
    <section className={`process ${open ? 'is-open' : ''} ${streaming ? 'is-live' : ''}`}>
      <button
        type="button"
        className="process-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="process-title">
          <span className={`process-pulse ${streaming ? 'is-live' : ''}`} aria-hidden="true" />
          过程
        </span>

        <span className="process-summary">
          {streaming ? (
            <>
              <span className="proc-live">执行中</span>
              <StatChip label="思考" value={stats.thinkingCount} />
              <StatChip label="工具" value={stats.toolCount} />
            </>
          ) : (
            <>
              <StatChip label="思考" value={stats.thinkingCount} />
              <StatChip label="工具" value={stats.toolCount} />
              {stats.durationMs !== null && stats.durationMs > 0 && (
                <span className="proc-chip mono">{formatDuration(stats.durationMs)}</span>
              )}
              {stats.composition.map((c) => (
                <span className="proc-chip proc-chip--muted" key={c.label}>
                  {c.label} {c.count}
                </span>
              ))}
              {finished !== null && <OutcomeChip stats={stats} />}
              {stats.denied > 0 && (
                <span className="proc-chip proc-chip--warn">被拒 {stats.denied}</span>
              )}
              {stats.failed > 0 && (
                <span className="proc-chip proc-chip--danger">失败 {stats.failed}</span>
              )}
            </>
          )}
        </span>

        {usage !== null && (
          <span className="proc-usage" title="本轮 / 本会话累计 token 用量">
            <span>
              本轮 <b>{formatTokens(usage.turnInputTokens)}</b> in /{' '}
              <b>{formatTokens(usage.turnOutputTokens)}</b> out
            </span>
            <span>
              累计 <b>{formatTokens(usage.sessionInputTokens)}</b> in /{' '}
              <b>{formatTokens(usage.sessionOutputTokens)}</b> out
            </span>
          </span>
        )}

        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} className="process-chevron" />
      </button>

      <Collapse open={open}>
        <div className="process-body">
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

          {lines.length > 0 && (
            <ul className="flow-list" aria-label="执行步骤">
              {lines.map((line) => (
                <ProcessLine
                  key={line.key}
                  line={line}
                  expanded={expanded === line.key}
                  onToggle={() => setExpanded((cur) => (cur === line.key ? null : line.key))}
                />
              ))}
            </ul>
          )}

          {stages.length > 0 && (
            <ol className="flow-stage-list" aria-label="阶段">
              {stages.map((s, i) => (
                <li key={`${s}-${i}`}>
                  <span className="flow-dot flow-dot--ok" aria-hidden="true" />
                  {s}
                </li>
              ))}
            </ol>
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
                    <Badge tone={c.negotiable ? 'neutral' : 'accent'}>{c.source}</Badge>
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

function StatChip({ label, value }: { readonly label: string; readonly value: number }): JSX.Element {
  return (
    <span className="proc-chip">
      {label} <b>{value}</b>
    </span>
  );
}

function OutcomeChip({ stats }: { readonly stats: ProcessStats }): JSX.Element {
  const tone = stats.failed > 0 || stats.outcome.includes('未完成') ? 'warn' : 'ok';
  return <span className={`proc-outcome proc-outcome--${tone}`}>{stats.outcome}</span>;
}

function ProcessLine({
  line,
  expanded,
  onToggle,
}: {
  readonly line: ProcLine;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  if (line.kind === 'thinking') {
    return (
      <li className="flow-item">
        <button type="button" className="flow-line" onClick={onToggle} aria-expanded={expanded}>
          <span className="flow-icon flow-icon--think">
            <Icon name="sparkle" size={14} />
          </span>
          <span className="flow-main">
            <span className="flow-label">思考</span>
            <span className="flow-preview">{previewText(line.text, 140)}</span>
          </span>
          <span className="flow-meta">
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          </span>
        </button>
        <Collapse open={expanded}>
          <div className="flow-detail">
            <p className="flow-reasoning">{line.text}</p>
          </div>
        </Collapse>
      </li>
    );
  }

  if (line.kind === 'text') {
    return (
      <li className="flow-item">
        <button type="button" className="flow-line" onClick={onToggle} aria-expanded={expanded}>
          <span className="flow-icon flow-icon--text">
            <Icon name="quote" size={14} />
          </span>
          <span className="flow-main">
            <span className="flow-label">输出</span>
            <span className="flow-preview">{previewText(line.text, 140)}</span>
          </span>
          <span className="flow-meta">
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          </span>
        </button>
        <Collapse open={expanded}>
          <div className="flow-detail">
            <p className="flow-reasoning">{line.text}</p>
          </div>
        </Collapse>
      </li>
    );
  }

  const tool = line.tool;
  const display = describeTool(tool);
  const target = previewText(display.detail, 80);
  const isOpen = expanded;

  return (
    <li className={`flow-item flow-item--tool is-${tool.status}`}>
      <button type="button" className="flow-line" onClick={onToggle} aria-expanded={isOpen}>
        <span className={`flow-icon flow-icon--${display.category}`}>
          <Icon name={display.icon} size={14} />
        </span>
        <span className="flow-main">
          <span className="flow-label">{display.label}</span>
          {target.length > 0 && <span className="flow-target mono">{target}</span>}
          <span className="sr-only">{TOOL_STATUS_LABEL[tool.status]}</span>
        </span>
        <span className="flow-meta">
          {tool.durationMs !== null && tool.durationMs > 0 && (
            <span className="mono">{formatDuration(tool.durationMs)}</span>
          )}
          <span className={`flow-dot flow-dot--${tool.status}`} aria-hidden="true" />
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
        </span>
      </button>
      <Collapse open={isOpen}>
        <div className="flow-detail">
          {tool.argsText.length > 0 && (
            <div>
              <p className="flow-detail-label">参数</p>
              <pre className="code-block">{tool.argsText}</pre>
            </div>
          )}
          <p className="flow-detail-label">结果</p>
          <pre className="code-block flow-output">
            {tool.output.length > 0 ? tool.output : '（没有返回内容）'}
          </pre>
        </div>
      </Collapse>
    </li>
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
