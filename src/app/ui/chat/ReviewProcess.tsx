'use client';

/**
 * 审查过程 —— 与主对话「过程」同一套视觉语言
 *
 * ★ 审查是独立的只读 Agent：轮次 / 思考 / 工具三元组必须能在
 *   运行中和结束后回看；历史 run 只有 traces，就只重建工具部分。
 * ★ 这里不复用 ProcessPanel 的数据结构（它的线条是给主对话排版的），
 *   但复用 process / flow / proc-* 的样式与折叠交互。
 */

import { useEffect, useRef, useState } from 'react';

import { Collapse } from '../components/Common';
import { Icon } from '../components/Icon';
import { formatTokens } from '../lib/format.js';
import {
  describeTool,
  isSubmissionOnlyRound,
  previewText,
  visibleProcessTools,
} from './processView.js';
import type {
  ReviewProcessState,
  ReviewRoundProcess,
  ReviewToolProcess,
  ReviewToolStatus,
} from './reviewLive.js';

function toolDotClass(status: ReviewToolStatus): string {
  if (status === 'running') return 'running';
  if (status === 'ok') return 'ok';
  if (status === 'denied') return 'denied';
  if (status === 'error') return 'error';
  return '';
}

export function ReviewProcess({
  state,
  streaming,
}: {
  readonly state: ReviewProcessState;
  readonly streaming: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(streaming);
  const [detail, setDetail] = useState<string | null>(null);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (streaming) setOpen(true);
    // 完成时收起过程，把首屏留给结论；过程仍保留在同一个折叠条里。
    else if (wasStreaming.current) {
      setOpen(false);
      setDetail(null);
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  const totalTokens =
    state.usage === null ? 0 : state.usage.inputTokens + state.usage.outputTokens;

  /*
   * 与主对话共用过滤口径：提交工具（含旧 trace 里的 submit_review）不展示；
   * 只有提交、没有其他可见内容的轮次整组丢掉，避免留下空分组/空线。
   */
  const visibleRounds = state.rounds
    .filter((round) => !isSubmissionOnlyRound(round))
    .map((round) => ({ ...round, tools: visibleProcessTools(round.tools) }))
    .filter((round) => round.reasoning.trim().length > 0 || round.tools.length > 0);

  // 非流式且过滤后没有可展示行：不渲染空的过程条。
  if (!streaming && visibleRounds.length === 0) return null;

  const toggleDetail = (key: string): void => {
    setDetail((current) => (current === key ? null : key));
  };

  return (
    <section
      className={`process review-process ${open ? 'is-open' : ''} ${streaming ? 'is-live' : ''}`}
      aria-label="审查过程"
    >
      <button
        type="button"
        className="process-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="process-title">
          <span className={`process-pulse ${streaming ? 'is-live' : ''}`} aria-hidden="true" />
          过程
        </span>

        {totalTokens > 0 && (
          <span className="proc-usage" title="本次审查总用量">
            总用量 <b>{formatTokens(totalTokens)}</b> token
          </span>
        )}

        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} className="process-chevron" />
      </button>

      <Collapse open={open}>
        <div className="process-body review-process-body">
          {visibleRounds.length === 0 ? (
            <p className="review-proc-empty">等待审查 Agent 的第一步…</p>
          ) : (
            visibleRounds.map((round) => (
              <ReviewRoundSection
                key={round.round}
                round={round}
                detail={detail}
                onToggle={toggleDetail}
              />
            ))
          )}
        </div>
      </Collapse>
    </section>
  );
}

function ReviewRoundSection({
  round,
  detail,
  onToggle,
}: {
  readonly round: ReviewRoundProcess;
  readonly detail: string | null;
  readonly onToggle: (key: string) => void;
}): JSX.Element {
  const reasoningKey = `round-${round.round}-reasoning`;
  const hasReasoning = round.reasoning.trim().length > 0;

  return (
    <section className="review-proc-round" aria-label="审查轮次">
      {hasReasoning && (
        <>
          <button
            type="button"
            className="flow-line review-proc-reason"
            aria-expanded={detail === reasoningKey}
            onClick={() => onToggle(reasoningKey)}
          >
            <span className="flow-icon flow-icon--think">
              <Icon name="sparkle" size={14} />
            </span>
            <span className="flow-main">
              <span className="flow-label">思考</span>
              <span className="flow-preview">{previewText(round.reasoning, 140)}</span>
            </span>
            <span className="flow-meta">
              <Icon name={detail === reasoningKey ? 'chevronDown' : 'chevronRight'} size={13} />
            </span>
          </button>
          <Collapse open={detail === reasoningKey}>
            <div className="review-proc-reason-text">{round.reasoning}</div>
          </Collapse>
        </>
      )}

      {round.tools.length > 0 && (
        <ul className="flow-list review-proc-tools" aria-label="审查工具调用">
          {round.tools.map((tool) => (
            <ReviewToolRow
              key={tool.callId}
              tool={tool}
              expanded={detail === `tool-${tool.callId}`}
              onToggle={() => onToggle(`tool-${tool.callId}`)}
            />
          ))}
        </ul>
      )}

      {!hasReasoning && round.tools.length === 0 && (
        <p className="review-proc-empty">等待审查 Agent 的下一步…</p>
      )}
    </section>
  );
}

function ReviewToolRow({
  tool,
  expanded,
  onToggle,
}: {
  readonly tool: ReviewToolProcess;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const display = describeTool(tool);
  const target = previewText(display.detail, 72);
  return (
    <li className={`flow-item flow-item--tool is-${tool.status}`}>
      <button type="button" className="flow-line" aria-expanded={expanded} onClick={onToggle}>
        <span className={`flow-icon flow-icon--${display.action}`}>
          <Icon name={display.icon} size={14} />
        </span>
        <span className="flow-main">
          <span className="flow-label review-proc-tool-name">{display.label}</span>
          {target.length > 0 && <span className="flow-target mono">{target}</span>}
        </span>
        <span className="flow-meta">
          <span className={`flow-dot${toolDotClass(tool.status) ? ` flow-dot--${toolDotClass(tool.status)}` : ''}`} aria-hidden="true" />
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
        </span>
      </button>

      <Collapse open={expanded}>
        <div className="flow-detail">
          <div>
            <p className="flow-detail-label">工具</p>
            <code className="review-proc-code">{tool.name.length > 0 ? tool.name : '工具'}</code>
          </div>
          <div>
            <p className="flow-detail-label">参数</p>
            <pre className="code-block review-proc-pre">
              {tool.argsText.trim().length > 0 ? tool.argsText : '（参数未捕获）'}
            </pre>
          </div>
          <div>
            <p className="flow-detail-label">结果</p>
            <pre className="code-block flow-output review-proc-pre">
              {tool.output.trim().length > 0 ? tool.output : '（没有返回内容）'}
            </pre>
          </div>
        </div>
      </Collapse>
    </li>
  );
}
