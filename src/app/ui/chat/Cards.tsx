'use client';

/**
 * 对话里的“结论卡片” —— 契约、复核、反思、产出
 *
 * ★ 这几张卡是产品与普通聊天界面的分界：
 *   普通聊天只给答案；这里还告诉你**答应做什么、做得对不对、学到了什么**。
 *   但它们都必须在答案**之后**，且默认克制（折叠），不抢正文的注意力。
 */

import { useState } from 'react';

import { Badge, Collapse } from '../components/Common';
import { Icon } from '../components/Icon';
import {
  CLASS_LABEL,
  DOMAIN_LABEL,
  SEVERITY_LABEL,
  formatDuration,
  formatPercent,
  formatTokens,
  truncate,
} from '../lib/format.js';
import type {
  AssumptionView,
  ContractView,
  ExecutionReport,
  MemoryRef,
  ReflectionView,
  TurnAudit,
  VerdictDto,
} from '../lib/types.js';

// ═══════════════════════════════════════════════════════════
// 假设
// ═══════════════════════════════════════════════════════════

export function AssumptionNotice({ assumption }: { readonly assumption: AssumptionView }): JSX.Element {
  return (
    <div className="notice notice--warm">
      <span className="notice-icon">
        <Icon name="info" size={16} />
      </span>
      <div className="notice-body">
        <strong>我先按这个理解做了</strong>
        <p>{assumption.note}</p>
        <div className="notice-tags">
          {assumption.domains.map((d) => (
            <Badge key={d} tone="outline">
              {DOMAIN_LABEL[d] ?? d}
            </Badge>
          ))}
          <span className="mono notice-confidence">把握 {formatPercent(assumption.confidence)}</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 契约
// ═══════════════════════════════════════════════════════════

export function ContractCard({ contract }: { readonly contract: ContractView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const low = contract.confidence < 0.6;

  return (
    <section className={`contract ${open ? 'is-open' : ''}`}>
      <button type="button" className="contract-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="contract-kicker">
          <Icon name="file" size={14} /> 任务契约
        </span>
        <span className="contract-deliverable">{truncate(contract.deliverable, 72)}</span>
        <span className={`contract-confidence ${low ? 'is-low' : ''}`}>
          把握 {formatPercent(contract.confidence)}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
      </button>

      <Collapse open={open}>
        <div className="contract-body">
          <div className="contract-block">
            <p className="mini-label">交付物</p>
            <p className="contract-text">{contract.deliverable}</p>
          </div>

          {contract.criteria.length > 0 && (
            <div className="contract-block">
              <p className="mini-label">完成判据 · {contract.criteria.length}</p>
              <ol className="criteria-list">
                {contract.criteria.map((c, i) => (
                  <li key={`${c}-${i}`}>
                    <span className="criteria-index mono">{String(i + 1).padStart(2, '0')}</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {contract.mustObey.length > 0 && (
            <div className="contract-block">
              <p className="mini-label">必须遵守</p>
              <ul className="must-list">
                {contract.mustObey.map((m, i) => (
                  <li key={`${m}-${i}`}>
                    <Icon name="shield" size={13} />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {contract.domains.length > 0 && (
            <div className="contract-domains">
              {contract.domains.map((d) => (
                <Badge key={d} tone="outline">
                  {DOMAIN_LABEL[d] ?? d}
                </Badge>
              ))}
            </div>
          )}

          {contract.clarifyingQuestion !== null && contract.clarifyingQuestion.length > 0 && (
            <div className="contract-question">
              <span>本来想先问：</span>
              <em>{contract.clarifyingQuestion}</em>
            </div>
          )}
        </div>
      </Collapse>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// 复核结论
// ═══════════════════════════════════════════════════════════

export function VerdictCard({
  verdict,
  onOpenAudit,
}: {
  readonly verdict: VerdictDto;
  readonly onOpenAudit?: (() => void) | undefined;
}): JSX.Element {
  const rejected = verdict.outcome === 'rejected';
  const [open, setOpen] = useState(rejected);
  const met = verdict.criteriaChecks.filter((c) => c.met).length;
  const total = verdict.criteriaChecks.length;

  return (
    <section className={`verdict ${rejected ? 'verdict--rejected' : 'verdict--accepted'}`}>
      <button type="button" className="verdict-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="verdict-icon">
          <Icon name={rejected ? 'alert' : 'checkCircle'} size={17} />
        </span>
        <span className="verdict-title">
          <strong>{rejected ? '已打回' : '复核通过'}</strong>
          <span className="verdict-summary">{verdict.summary}</span>
        </span>
        <span className="verdict-facts">
          {total > 0 && (
            <span className="mono">
              {met}/{total} 判据
            </span>
          )}
          {verdict.issues.length > 0 && (
            <span className="verdict-issue-count">{verdict.issues.length} 个问题</span>
          )}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
        </span>
      </button>

      <Collapse open={open}>
        <div className="verdict-body">
          {total > 0 ? (
            <div className="verdict-block">
              <p className="mini-label">判据核对 · {met}/{total}</p>
              <ul className="criteria-check">
                {verdict.criteriaChecks.map((c, i) => (
                  <li key={`${c.criterion}-${i}`} className={c.met ? 'is-met' : 'is-missing'}>
                    <span className="check-icon">
                      <Icon name={c.met ? 'check' : 'close'} size={13} />
                    </span>
                    <span className="check-text">
                      {c.criterion}
                      {c.note !== undefined && c.note.length > 0 && <small>{c.note}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="verdict-muted">这条结论来自较早的记录，没有留下判据核对。</p>
          )}

          {verdict.issues.length > 0 && (
            <div className="verdict-block">
              <p className="mini-label">发现的问题</p>
              <ul className="issue-list">
                {verdict.issues.map((issue, i) => (
                  <li key={`${issue.statement}-${i}`}>
                    <div className="issue-top">
                      <Badge tone={issue.severity === 'blocking' ? 'danger' : issue.severity === 'advisory' ? 'warn' : 'neutral'}>
                        {SEVERITY_LABEL[issue.severity]}
                      </Badge>
                      <span>{issue.statement}</span>
                    </div>
                    {issue.memoryContent !== undefined && (
                      <p className="issue-memory">关联记忆：{issue.memoryContent}</p>
                    )}
                    {issue.suggestion !== undefined && <p className="issue-suggestion">建议：{issue.suggestion}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="verdict-meta">
            <span>
              <Icon name="clock" size={13} /> {formatDuration(verdict.durationMs)}
            </span>
            <span className="mono">
              本轮 {formatTokens(verdict.usage.inputTokens)} in · {formatTokens(verdict.usage.outputTokens)} out
              {verdict.sessionUsage !== undefined && (
                <>
                  {' · '}会话 {formatTokens(verdict.sessionUsage.inputTokens)} in ·{' '}
                  {formatTokens(verdict.sessionUsage.outputTokens)} out
                </>
              )}
            </span>
            {verdict.artifactIds.length > 0 && <span>{verdict.artifactIds.length} 个产出物</span>}
            {onOpenAudit !== undefined && (
              <button type="button" className="text-btn" onClick={onOpenAudit}>
                查看依据
                <Icon name="chevronRight" size={13} />
              </button>
            )}
          </div>
        </div>
      </Collapse>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// 反思
// ═══════════════════════════════════════════════════════════

export function ReflectionCard({
  reflection,
  onOpenMemory,
}: {
  readonly reflection: ReflectionView;
  readonly onOpenMemory: () => void;
}): JSX.Element | null {
  if (reflection.failed) {
    return (
      <div className="reflect reflect--failed">
        <span className="reflect-icon">
          <Icon name="info" size={15} />
        </span>
        <span>这次没能完成反思{reflection.failureReason !== null ? `：${reflection.failureReason}` : '。'}</span>
      </div>
    );
  }

  const learned = reflection.pendingReview + reflection.admittedAutonomously;
  if (learned === 0) {
    return (
      <div className="reflect reflect--quiet">
        <span className="reflect-icon">
          <Icon name="sparkle" size={15} />
        </span>
        <span>
          这次没有需要新记住的内容
          {reflection.skippedDuplicates > 0 ? `（${reflection.skippedDuplicates} 条与已有记忆重复）` : ''}。
        </span>
      </div>
    );
  }

  return (
    <div className="reflect">
      <span className="reflect-icon">
        <Icon name="sparkle" size={15} />
      </span>
      <span className="reflect-text">
        刚记录 <strong>{learned}</strong> 条试行记忆
        {reflection.pendingReview > 0 ? '，系统会按独立证据自动验证' : '，已按分级策略自动生效'}
        {reflection.skippedDuplicates > 0 ? `；${reflection.skippedDuplicates} 条重复已跳过` : ''}。
      </span>
      {reflection.pendingReview > 0 && (
        <button type="button" className="text-btn" onClick={onOpenMemory}>
          查看试行
          <Icon name="chevronRight" size={13} />
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 产出与发现
// ═══════════════════════════════════════════════════════════

const ARTIFACT_KIND: Record<string, string> = {
  text: '文本',
  list: '清单',
  plan: '方案',
  table: '表格',
  quiz: '练习',
  file: '文件',
};

export function ReportsPanel({ reports }: { readonly reports: readonly ExecutionReport[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (reports.length === 0) return null;

  const hasContent = reports.some(
    (r) => r.artifacts.length > 0 || r.findings.length > 0 || r.uncertainties.length > 0,
  );
  if (!hasContent) return null;

  return (
    <section className={`reports ${open ? 'is-open' : ''}`}>
      <button type="button" className="reports-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="reports-title">
          <Icon name="database" size={14} /> 产出与发现
        </span>
        <span className="reports-meta">
          {reports.reduce((n, r) => n + r.artifacts.length, 0)} 个产出 ·{' '}
          {reports.reduce((n, r) => n + r.findings.length, 0)} 条发现
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
      </button>

      <Collapse open={open}>
        <div className="reports-body">
          {reports.map((r, ri) => (
            <article key={`${r.taskId}-${ri}`} className="report">
              <div className="report-head">
                <Badge tone="outline">{DOMAIN_LABEL[r.servant] ?? r.servant}</Badge>
                <Badge tone={r.status === 'done' ? 'accent' : r.status === 'blocked' ? 'warn' : 'danger'}>
                  {r.status === 'done' ? '完成' : r.status === 'blocked' ? '受阻' : '失败'}
                </Badge>
                <span className="report-task mono">{truncate(r.taskId, 24)}</span>
              </div>

              {r.artifacts.map((a, ai) => (
                <div key={`${a.kind}-${ai}`} className="report-artifact">
                  <p className="mini-label">
                    {ARTIFACT_KIND[a.kind] ?? a.kind}
                    {a.itemCount > 1 ? ` · ${a.itemCount} 项` : ''}
                  </p>
                  <pre className="artifact-text">{a.text}</pre>
                </div>
              ))}

              {r.findings.length > 0 && (
                <div className="report-findings">
                  <p className="mini-label">发现</p>
                  <ul>
                    {r.findings.map((f, fi) => (
                      <li key={`${f.statement}-${fi}`}>
                        <Badge tone="neutral">{f.kind}</Badge>
                        <span>{f.statement}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.uncertainties.length > 0 && (
                <div className="report-uncertain">
                  <p className="mini-label">不确定的地方</p>
                  <ul>
                    {r.uncertainties.map((u, ui) => (
                      <li key={`${u}-${ui}`}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}

              {r.needsButlerDecision !== undefined && (
                <p className="report-needs">需要裁决：{r.needsButlerDecision}</p>
              )}
            </article>
          ))}
        </div>
      </Collapse>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// 引用记忆
// ═══════════════════════════════════════════════════════════

export function MemoryRefs({ refs }: { readonly refs: readonly MemoryRef[] }): JSX.Element | null {
  if (refs.length === 0) return null;
  return (
    <div className="memrefs">
      <span className="memrefs-label">
        <Icon name="memory" size={13} /> 引用记忆 · {refs.length}
      </span>
      <div className="memrefs-list">
        {refs.map((r) => (
          <span key={r.id} className="memref" title={r.content}>
            {truncate(r.content, 34)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 本轮依据
// ═══════════════════════════════════════════════════════════

export function AuditStrip({
  range,
  audit,
  onOpen,
}: {
  readonly range: { readonly fromSeq: number; readonly toSeq: number };
  readonly audit: TurnAudit | null;
  readonly onOpen: () => void;
}): JSX.Element {
  const recalls = audit?.recalls.reduce((n, r) => n + r.count, 0) ?? 0;
  const injections = audit?.injections.length ?? 0;
  const blocked = audit?.hardChecks.length ?? 0;

  return (
    <div className={`audit-strip ${audit === null ? 'is-loading' : ''}`}>
      <span className="audit-strip-label">
        <Icon name="audit" size={13} /> 本轮依据
      </span>
      {audit === null ? (
        <span className="audit-strip-muted">正在读取事件…</span>
      ) : (
        <span className="audit-strip-facts">
          <span>召回 {recalls}</span>
          <span>注入 {injections}</span>
          {blocked > 0 && <span className="is-danger">拦截 {blocked}</span>}
        </span>
      )}
      <span className="audit-strip-range mono">
        seq {range.fromSeq}–{range.toSeq}
      </span>
      <button type="button" className="text-btn" onClick={onOpen}>
        展开
        <Icon name="chevronRight" size={13} />
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 注入约束（独立小块，供历史消息没有 process 时使用）
// ═══════════════════════════════════════════════════════════

export function ConstraintChips({
  constraints,
}: {
  readonly constraints: readonly { readonly content: string; readonly source: string; readonly negotiable: boolean }[];
}): JSX.Element | null {
  if (constraints.length === 0) return null;
  return (
    <div className="constraint-chips">
      <span className="mini-label">
        <Icon name="lock" size={12} /> 注入约束 · {constraints.length}
      </span>
      <div>
        {constraints.map((c, i) => (
          <span key={`${c.content}-${i}`} className="constraint-chip" title={c.content}>
            <Badge tone={c.negotiable ? 'neutral' : 'accent'}>
              {CLASS_LABEL[c.source as keyof typeof CLASS_LABEL] ?? c.source}
            </Badge>
            {truncate(c.content, 38)}
          </span>
        ))}
      </div>
    </div>
  );
}
