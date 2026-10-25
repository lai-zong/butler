/**
 * 界面数据投影 —— 把核心层状态翻译成**界面能直接渲染**的形状
 *
 * 设计纪律：
 *   ① 只读：这里全部是纯函数，不产生事件、不改状态
 *   ② 不解释：摘要只引用事件里已有的字段，不替事件流做推断
 *   ③ 标签由服务端给：中文名与核心层保持同源，避免界面自己维护一份映射后漂移
 *
 * ⚠️ 与 `audit/readAudit.ts` 的分工：
 *   那个负责「一轮对话的依据」（召回 / 注入 / 硬拦截 / 授权），
 *   这个负责「列表、统计、会话、事件流」这类通用投影。
 */

import type { ChatMessage, ChatSession, Verdict } from '@/core/chat/types.js';
import type { SessionEvent } from '@/core/events/types.js';
import { EVENT_FAMILIES, isLegacyEventType } from '@/core/events/types.js';
import type { MemoryEntry, MemoryClass, MemoryKind, MemoryLifecycle } from '@/core/memory/types.js';
import { LIFECYCLE_LABEL, MEMORY_CLASS_LABEL } from '@/core/memory/types.js';
import { domainName } from '@/core/domain/types.js';

// ═══════════════════════════════════════════════════════════
// 标签
// ═══════════════════════════════════════════════════════════

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  principle: '原则',
  summary: '长期状态',
};

export const EVENT_FAMILY_LABEL: Record<string, string> = {
  reasoning: '推理与工具',
  execution: '执行',
  supervision: '监督',
  memoryLifecycle: '记忆',
  memoryPartition: '分权',
  evolution: '演化',
  reflection: '反思与观察',
  multimodal: '多模态',
  lifecycle: '生命周期与安全',
  chat: '会话',
  context: '上下文',
  mcp: 'MCP',
  legacy: '历史事件',
  other: '其他',
};

export const ACTOR_LABEL: Record<string, string> = {
  user: '你',
  butler: '管家',
  supervisor: '监督员',
  scheduler: '定时器',
  system: '系统',
  servant: '仆人（历史）',
};

/** 事件类型 → 中文名。未列出的类型原样显示（不猜）。 */
export const EVENT_LABEL: Record<string, string> = {
  // 推理
  'thought.delta': '思考片段',
  'thought.done': '思考完成',
  'plan.created': '生成计划',
  'plan.revised': '修订计划',
  'tool.call': '调用工具',
  'tool.result': '工具返回',
  'context.compacted': '上下文压缩',
  // 执行
  'route.decided': '意图路由（历史）',
  'contract.written': '写下任务契约',
  'butler.executed': '管家执行完成',
  'route.clarify': '请求澄清（历史）',
  'route.assumed': '低置信度假设',
  'route.rerouted': '改派（历史）',
  'constraint.injected': '注入约束',
  // 监督
  'supervisor.observe': '监督员复核',
  'supervisor.omissionDetected': '检出遗漏',
  'supervisor.principleViolated': '原则被违背',
  'conflict.detected': '检出冲突',
  'conflict.judgeFailed': '冲突判断失败',
  'conflict.resolved': '冲突已裁决',
  'constraint.hardBlocked': '硬约束拦截',
  // 记忆生命周期
  'memory.created': '写入记忆',
  'memory.recalled': '召回记忆',
  'memory.candidate': '生成候选',
  'memory.approved': '记忆通过',
  'memory.rejected': '记忆被拒',
  'memory.revised': '记忆修订',
  'memory.archived': '记忆归档',
  'memory.merged': '记忆合并',
  'principle.derived': '生成原则',
  'principle.applied': '应用原则',
  'principle.effectMeasured': '效果验证',
  // 分权
  'memory.writeAttempted': '越权写入尝试',
  'grant.requested': '请求授权',
  'grant.approved': '授权通过',
  'grant.denied': '授权被拒',
  'grant.used': '使用授权',
  'grant.expired': '授权过期',
  // 演化
  'fitness.updated': '适应度更新',
  'memory.dormant': '记忆休眠',
  'memory.revived': '记忆唤醒',
  'evolution.thresholdAdapted': '阈值自适应',
  // 反思与观察
  'reflection.started': '反思开始',
  'reflection.done': '反思完成',
  'profile.snapshot': '画像快照',
  'activity.sampled': '行为采样',
  'activity.aggregated': '行为聚合',
  'attachment.parsed': '附件解析',
  'pattern.derived': '推导规律',
  'pattern.invalidated': '规律失效',
  // 生命周期与安全
  'intervention.pause': '暂停',
  'intervention.resume': '继续',
  'intervention.correct': '人工纠正',
  'intervention.reroute': '人工改派',
  'intervention.weightAdjusted': '调整权重',
  'intervention.forgotten': '遗忘记忆',
  'credential.authorized': '凭证授权',
  'credential.used': '使用凭证',
  'action.classified': '动作分级',
  'action.blocked': '动作被拦截',
  'injection.detected': '检出注入',
  'artifact.created': '产出物创建',
  'artifact.revised': '产出物修订',
  'artifact.superseded': '产出物被取代',
  'checkpoint.created': '创建检查点',
  'session.rollback': '回退会话',
  'schedule.triggered': '定时任务触发',
  'session.forked': '新建会话',
  'session.cancelled': '用户取消',
  'session.ended': '会话结束',
  // MCP
  'mcp.serverAdded': '添加 MCP 服务',
  'mcp.serverRemoved': '移除 MCP 服务',
  'mcp.serverConnected': 'MCP 已连接',
  'mcp.serverDisconnected': 'MCP 已断开',
  'mcp.serverFailed': 'MCP 连接失败',
  'mcp.toolsDiscovered': '发现 MCP 工具',
  'mcp.policyChanged': 'MCP 策略变更',
  // 会话与练习
  'session.message': '消息',
  'session.reply': '回复更新',
  'session.verdict': '复核结论',
  'review.run': '手动复核',
  'quiz.created': '生成练习',
  'quiz.graded': '批改练习',
  // 历史
  'dispatch.created': '派发任务（历史）',
  'dispatch.stepStarted': '步骤开始（历史）',
  'dispatch.stepDone': '步骤完成（历史）',
  'dispatch.stepFailed': '步骤失败（历史）',
  'servant.report': '仆人汇报（历史）',
  'servant.blocked': '仆人受阻（历史）',
  'servant.needsDecision': '请求裁决（历史）',
};

const FAMILY_OF = new Map<string, string>();
for (const [family, types] of Object.entries(EVENT_FAMILIES)) {
  for (const t of types as readonly string[]) FAMILY_OF.set(t, family);
}

export function eventFamily(type: string): string {
  return FAMILY_OF.get(type) ?? (isLegacyEventType(type as never) ? 'legacy' : 'other');
}

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type;
}

// ═══════════════════════════════════════════════════════════
// 记忆
// ═══════════════════════════════════════════════════════════

export interface MemoryDto {
  readonly id: string;
  readonly memClass: MemoryClass;
  readonly memClassLabel: string;
  readonly kind: MemoryKind;
  readonly kindLabel: string;
  readonly content: string;
  readonly subject: string | null;
  readonly confidence: number;
  readonly fitness: number;
  readonly lifecycle: MemoryLifecycle;
  readonly lifecycleLabel: string;
  readonly domain: string | null;
  readonly domainLabel: string | null;
  readonly evidence: readonly string[];
  readonly evidenceCount: number;
  readonly hitCount: number;
  readonly useCount: number;
  readonly revivedCount: number;
  readonly version: number;
  readonly scope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastHitAt: number | null;
  readonly dormantSince: number | null;
  readonly archivedAt: number | null;
  readonly effectiveness: {
    readonly applied: number;
    readonly succeeded: number;
    readonly lastAppliedAt: number;
  } | null;
  readonly principle: {
    readonly condition: string;
    readonly action: string;
    readonly fromVerdict: string | null;
  } | null;
  readonly hasCredential: boolean;
  readonly grantCount: number;
  readonly mergedFrom: readonly string[];
}

export function toMemoryDto(e: MemoryEntry): MemoryDto {
  return {
    id: e.id,
    memClass: e.memClass,
    memClassLabel: MEMORY_CLASS_LABEL[e.memClass],
    kind: e.kind,
    kindLabel: KIND_LABEL[e.kind],
    content: e.content,
    subject: e.subject ?? null,
    confidence: e.confidence,
    fitness: e.fitness,
    lifecycle: e.lifecycle,
    lifecycleLabel: LIFECYCLE_LABEL[e.lifecycle],
    domain: e.domain ?? null,
    domainLabel: e.domain !== undefined ? domainName(e.domain) : null,
    evidence: e.evidence,
    evidenceCount: e.evidence.length,
    hitCount: e.hitCount,
    useCount: e.useCount,
    revivedCount: e.revivedCount,
    version: e.version,
    scope: e.scope,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastHitAt: e.lastHitAt ?? null,
    dormantSince: e.dormantSince ?? null,
    archivedAt: e.archivedAt ?? null,
    effectiveness: e.effectiveness
      ? {
          applied: e.effectiveness.applied,
          succeeded: e.effectiveness.succeeded,
          lastAppliedAt: e.effectiveness.lastAppliedAt,
        }
      : null,
    principle: e.principle
      ? {
          condition: e.principle.condition,
          action: e.principle.action,
          fromVerdict: e.principle.fromVerdict ?? null,
        }
      : null,
    hasCredential: e.capability !== undefined,
    grantCount: e.grants?.length ?? 0,
    mergedFrom: e.mergedFrom ?? [],
  };
}

export interface MemoryStats {
  readonly total: number;
  readonly pending: number;
  readonly active: number;
  readonly dormant: number;
  readonly archived: number;
  readonly hardConstraints: number;
  readonly avgFitness: number;
  readonly avgConfidence: number;
  readonly byLifecycle: Record<MemoryLifecycle, number>;
  readonly byKind: Record<MemoryKind, number>;
  readonly byClass: Record<MemoryClass, number>;
  readonly byDomain: Record<string, number>;
  readonly addedLast7Days: number;
  readonly hitLast7Days: number;
  readonly principles: {
    readonly total: number;
    readonly applied: number;
    readonly succeeded: number;
  };
  /** 适应度分布：0—20 / 20—40 / … / 80—100（共 5 档） */
  readonly fitnessBuckets: readonly number[];
}

export function computeMemoryStats(all: readonly MemoryEntry[], now = Date.now()): MemoryStats {
  const byLifecycle: Record<MemoryLifecycle, number> = {
    candidate: 0,
    active: 0,
    dormant: 0,
    archived: 0,
  };
  const byKind: Record<MemoryKind, number> = { fact: 0, preference: 0, principle: 0, summary: 0 };
  const byClass: Record<MemoryClass, number> = {
    global_constraint: 0,
    global_shared: 0,
    sensitive: 0,
    domain: 0,
  };
  const byDomain: Record<string, number> = {};
  const buckets = [0, 0, 0, 0, 0];

  let fitnessSum = 0;
  let fitnessCount = 0;
  let confidenceSum = 0;
  let addedLast7Days = 0;
  let hitLast7Days = 0;
  let applied = 0;
  let succeeded = 0;

  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  for (const e of all) {
    byLifecycle[e.lifecycle] += 1;
    byKind[e.kind] += 1;
    byClass[e.memClass] += 1;
    const d = e.domain ?? 'global';
    byDomain[d] = (byDomain[d] ?? 0) + 1;
    confidenceSum += e.confidence;

    if (e.memClass !== 'global_constraint') {
      fitnessSum += e.fitness;
      fitnessCount += 1;
      const idx = Math.min(4, Math.max(0, Math.floor(e.fitness * 5)));
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    if (e.createdAt >= weekAgo) addedLast7Days += 1;
    if (e.lastHitAt !== null && e.lastHitAt >= weekAgo) hitLast7Days += 1;
    if (e.effectiveness !== undefined) {
      applied += e.effectiveness.applied;
      succeeded += e.effectiveness.succeeded;
    }
  }

  const principles = all.filter((e) => e.kind === 'principle');

  return {
    total: all.length,
    pending: byLifecycle.candidate,
    active: byLifecycle.active,
    dormant: byLifecycle.dormant,
    archived: byLifecycle.archived,
    hardConstraints: byClass.global_constraint,
    avgFitness: fitnessCount > 0 ? round3(fitnessSum / fitnessCount) : 0,
    avgConfidence: all.length > 0 ? round3(confidenceSum / all.length) : 0,
    byLifecycle,
    byKind,
    byClass,
    byDomain,
    addedLast7Days,
    hitLast7Days,
    principles: { total: principles.length, applied, succeeded },
    fitnessBuckets: buckets,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════
// 会话
// ═══════════════════════════════════════════════════════════

export interface SessionDto {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly verdictCount: number;
  readonly lastPreview: string;
}

export interface MessageDto {
  readonly id: string;
  readonly sessionId: string;
  readonly role: ChatMessage['role'];
  readonly servant: string | null;
  readonly servantLabel: string | null;
  readonly text: string;
  readonly reasoning: string | null;
  readonly reasoningTranslated: string | null;
  readonly status: ChatMessage['status'];
  readonly createdAt: number;
  readonly memoryRefs: readonly { readonly id: string; readonly content: string }[];
  readonly agentTrace: ChatMessage['agentTrace'] | null;
  readonly servantReports: ChatMessage['servantReports'] | null;
}

export interface VerdictDto {
  readonly id: string;
  readonly sessionId: string;
  readonly forMessageId: string;
  readonly outcome: Verdict['outcome'];
  readonly summary: string;
  readonly reviewed?: boolean;
  readonly issues: Verdict['issues'];
  readonly criteriaChecks: Verdict['criteriaChecks'];
  readonly steps: Verdict['steps'];
  readonly durationMs: number;
  readonly usage: Verdict['usage'];
  readonly sessionUsage?: Verdict['sessionUsage'];
  readonly artifactIds: readonly string[];
  readonly createdAt: number;
}

export function toMessageDto(m: ChatMessage): MessageDto {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    servant: m.servant ?? null,
    servantLabel: m.servant !== undefined ? domainName(m.servant) : null,
    text: m.text,
    reasoning: m.reasoning ?? null,
    reasoningTranslated: m.reasoningTranslated ?? null,
    status: m.status,
    createdAt: m.createdAt,
    ...(m.auditRange !== undefined ? { auditRange: m.auditRange } : {}),
    memoryRefs: m.memoryRefs ?? [],
    agentTrace: m.agentTrace ?? null,
    servantReports: m.servantReports ?? null,
  };
}

export function toVerdictDto(v: Verdict): VerdictDto {
  return {
    id: v.id,
    sessionId: v.sessionId,
    forMessageId: v.forMessageId,
    outcome: v.outcome,
    summary: v.summary,
    ...(v.reviewed !== undefined ? { reviewed: v.reviewed } : {}),
    issues: v.issues,
    criteriaChecks: v.criteriaChecks,
    steps: v.steps,
    durationMs: v.durationMs,
    usage: v.usage,
    ...(v.sessionUsage !== undefined ? { sessionUsage: v.sessionUsage } : {}),
    artifactIds: v.artifactIds,
    createdAt: v.createdAt,
  };
}

/** 从消息里推导一个可读的会话标题（核心不存标题，避免多写一份真相）。 */
export function sessionTitle(session: ChatSession, messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (firstUser !== undefined) {
    const t = firstUser.text.replace(/\s+/g, ' ').trim();
    if (t.length > 0) return t.length > 24 ? `${t.slice(0, 24)}…` : t;
  }
  return session.title;
}

export function toSessionDto(
  session: ChatSession,
  messages: readonly ChatMessage[],
  verdicts: readonly Verdict[],
): SessionDto {
  const last = messages[messages.length - 1];
  const preview =
    last !== undefined
      ? last.text.replace(/\s+/g, ' ').trim().slice(0, 90)
      : '';
  return {
    id: session.id,
    title: sessionTitle(session, messages),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    messageCount: messages.length,
    verdictCount: verdicts.length,
    lastPreview: preview,
  };
}

// ═══════════════════════════════════════════════════════════
// 事件流
// ═══════════════════════════════════════════════════════════

export interface EventDto {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly family: string;
  readonly familyLabel: string;
  readonly actor: string;
  readonly actorLabel: string;
  readonly at: number;
  readonly legacy: boolean;
  readonly summary: string;
}

/** 读一个字段（payload 是 unknown，必须逐项收窄）。 */
function field(p: Record<string, unknown>, key: string): unknown {
  return p[key];
}

function str(p: Record<string, unknown>, key: string): string {
  const v = field(p, key);
  return typeof v === 'string' ? v : '';
}

function num(p: Record<string, unknown>, key: string): number | null {
  const v = field(p, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arrLen(p: Record<string, unknown>, key: string): number | null {
  const v = field(p, key);
  return Array.isArray(v) ? v.length : null;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 一句话摘要。
 *
 * ⚠️ 只引用事件里**已经存在**的字段。没有可读字段就返回空字符串，
 *    界面据此显示“无摘要”，而不是编一句看起来合理的话。
 */
export function eventSummary(type: string, payload: unknown): string {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const cls = str(p, 'memClass');
  const classLabel = MEMORY_CLASS_LABEL[cls as MemoryClass] ?? cls;

  switch (type) {
    case 'contract.written': {
      const deliverable = str(p, 'deliverable');
      const criteria = arrLen(p, 'criteria');
      const domains = Array.isArray(p['domains']) ? (p['domains'] as unknown[]).filter((x) => typeof x === 'string') : [];
      const parts: string[] = [];
      if (deliverable.length > 0) parts.push(clip(deliverable, 80));
      if (criteria !== null) parts.push(`${criteria} 条判据`);
      if (domains.length > 0) parts.push(domains.map((d) => domainName(String(d))).join('、'));
      return parts.join(' · ');
    }
    case 'butler.executed': {
      const status = str(p, 'status');
      const domain = str(p, 'domain') || str(p, 'servant');
      const parts: string[] = [];
      if (status.length > 0) parts.push(status);
      if (domain.length > 0) parts.push(domainName(domain));
      return parts.join(' · ');
    }
    case 'constraint.injected': {
      const content = str(p, 'content');
      const source = str(p, 'source');
      const sourceLabel = MEMORY_CLASS_LABEL[source as MemoryClass] ?? source;
      return [clip(content, 90), sourceLabel].filter((x) => x.length > 0).join(' · ');
    }
    case 'constraint.hardBlocked': {
      const content = str(p, 'content');
      const deterministic = p['deterministic'] === true ? '确定性判定' : '';
      return [clip(content, 90), deterministic].filter((x) => x.length > 0).join(' · ');
    }
    case 'memory.created': {
      const entry = (typeof p['entry'] === 'object' && p['entry'] !== null ? p['entry'] : {}) as Record<string, unknown>;
      const kind = str(entry, 'kind');
      const content = str(entry, 'content');
      return [KIND_LABEL[kind as MemoryKind] ?? kind, clip(content, 80)].filter((x) => x.length > 0).join(' · ');
    }
    case 'memory.recalled': {
      const count = num(p, 'count') ?? arrLen(p, 'items') ?? 0;
      return `召回 ${count} 条记忆`;
    }
    case 'memory.candidate':
    case 'memory.approved':
    case 'memory.rejected':
    case 'memory.revised':
    case 'memory.archived':
    case 'memory.merged': {
      const decision = str(p, 'decision');
      const reason = str(p, 'reason');
      const content = str(p, 'content');
      const parts = [decision, clip(reason || content, 70)].filter((x) => x.length > 0);
      return parts.join(' · ');
    }
    case 'supervisor.observe': {
      const outcome = str(p, 'outcome');
      const summary = str(p, 'summary');
      return [outcome, clip(summary, 90)].filter((x) => x.length > 0).join(' · ');
    }
    case 'session.cancelled': {
      const phase = str(p, 'phase') || '未知阶段';
      const calls = num(p, 'toolCalls') ?? 0;
      const results = num(p, 'toolResults') ?? 0;
      const from = num(p, 'fromSeq') ?? 0;
      const to = num(p, 'toSeq') ?? 0;
      return clip(
        `用户在「${phase}」停止 · 工具 ${calls} 次/${results} 个结果 · seq ${from}–${to}`,
        100,
      );
    }
    case 'supervisor.omissionDetected':
    case 'supervisor.principleViolated':
    case 'conflict.detected':
    case 'conflict.resolved': {
      const statement = str(p, 'statement') || str(p, 'summary') || str(p, 'reason');
      return clip(statement, 100);
    }
    case 'tool.call': {
      const name = str(p, 'toolName');
      const tier = str(p, 'tier');
      const auth = str(p, 'authorization');
      return [name, tier, auth].filter((x) => x.length > 0).join(' · ');
    }
    case 'tool.result': {
      const name = str(p, 'toolName');
      const ok = p['ok'] === true ? '成功' : p['denied'] === true ? '被拒绝' : '失败';
      const duration = num(p, 'durationMs');
      return [name, ok, duration !== null ? `${duration}ms` : ''].filter((x) => x.length > 0).join(' · ');
    }
    case 'session.message': {
      const role = str(p, 'role');
      const text = str(p, 'text');
      const roleLabel = role === 'user' ? '你' : role === 'butler' ? '管家' : role;
      return [roleLabel, clip(text, 100)].filter((x) => x.length > 0).join(' · ');
    }
    case 'session.verdict': {
      const outcome = str(p, 'outcome');
      const summary = str(p, 'summary');
      const issues = num(p, 'issueCount');
      return [outcome === 'accepted' ? '通过' : '打回', clip(summary, 80), issues !== null ? `${issues} 个问题` : '']
        .filter((x) => x.length > 0)
        .join(' · ');
    }
    case 'review.run': {
      const run = p['run'];
      if (typeof run !== 'object' || run === null) return '';
      const status = (run as { status?: unknown }).status;
      const report = (run as { report?: unknown }).report;
      const summary =
        typeof report === 'object' && report !== null
          ? str(report as Record<string, unknown>, 'summary')
          : '';
      return [typeof status === 'string' ? status : '', clip(summary, 80)]
        .filter((x) => x.length > 0)
        .join(' · ');
    }
    case 'quiz.created': {
      const n = arrLen(p, 'questions');
      return n !== null ? `${n} 道题` : '';
    }
    case 'quiz.graded': {
      const right = num(p, 'right');
      const total = num(p, 'total');
      return right !== null && total !== null ? `答对 ${right}/${total}` : '';
    }
    case 'reflection.done': {
      const pending = num(p, 'pendingReview');
      const admitted = num(p, 'admittedAutonomously');
      const parts: string[] = [];
      if (admitted !== null) parts.push(`自主生效 ${admitted}`);
      if (pending !== null) parts.push(`待审 ${pending}`);
      return parts.join(' · ');
    }
    case 'context.compacted': {
      const before = num(p, 'beforeTokens');
      const after = num(p, 'afterTokens');
      return before !== null && after !== null ? `${before} → ${after} tokens` : '';
    }
    case 'memory.writeAttempted': {
      const actor = str(p, 'actor');
      const reason = str(p, 'reason');
      return [actor, reason, p['rejected'] === true ? '已拒绝' : ''].filter((x) => x.length > 0).join(' · ');
    }
    case 'grant.requested':
    case 'grant.approved':
    case 'grant.denied':
    case 'grant.used':
    case 'grant.expired': {
      const to = str(p, 'toServant');
      const reason = str(p, 'reason');
      return [to.length > 0 ? domainName(to) : '', clip(reason, 70)].filter((x) => x.length > 0).join(' · ');
    }
    case 'activity.sampled': {
      const action = str(p, 'action');
      const label: Record<string, string> = {
        consentGranted: '用户同意',
        consentRevoked: '撤回同意',
        enabled: '开启采集',
        disabled: '关闭采集',
        retentionChanged: '调整保留期',
        recorded: '记录一次采样',
      };
      return label[action] ?? action;
    }
    case 'artifact.created': {
      const label = str(p, 'label') || str(p, 'kind');
      return clip(label, 80);
    }
    case 'schedule.triggered': {
      const kind = str(p, 'kind');
      return kind;
    }
    case 'mcp.serverConnected':
    case 'mcp.serverFailed':
    case 'mcp.toolsDiscovered': {
      const id = str(p, 'id') || str(p, 'serverId');
      const count = num(p, 'tools') ?? num(p, 'toolCount');
      return [id, count !== null ? `${count} 个工具` : ''].filter((x) => x.length > 0).join(' · ');
    }
    default: {
      // 兜底：不解释，只给出最可读的一两个字段
      const candidates = ['summary', 'reason', 'content', 'text', 'note', 'statement', 'label'];
      for (const k of candidates) {
        const v = str(p, k);
        if (v.length > 0) return clip(v, 100);
      }
      if (classLabel.length > 0) return classLabel;
      return '';
    }
  }
}

export function toEventDto(e: SessionEvent): EventDto {
  const family = eventFamily(e.type);
  return {
    seq: e.seq,
    id: e.id,
    type: e.type,
    label: eventLabel(e.type),
    family,
    familyLabel: EVENT_FAMILY_LABEL[family] ?? family,
    actor: e.actor,
    actorLabel: ACTOR_LABEL[e.actor] ?? e.actor,
    at: e.createdAt,
    legacy: isLegacyEventType(e.type),
    summary: eventSummary(e.type, e.payload),
  };
}

/**
 * 审计页「原始事件」的对外投影 —— 去掉**不该给任何读者看**的字段。
 *
 * ★ 当前唯一规则：`quiz.created.payload.answers` 是答案卷。
 *   练习组件的承诺是"提交后才下发答案"；如果审计页能展开原始 payload，
 *   这个承诺就自相矛盾（实测：点开「生成练习」就能看到 correct）。
 *
 * ⚠️ 只影响 HTTP 投影，不改事件本身 —— 服务端批改仍需要 answers。
 */
export function sanitizeEventForClient(e: SessionEvent): SessionEvent {
  if (e.type !== 'quiz.created') return e;
  const payload = e.payload;
  if (typeof payload !== 'object' || payload === null) return e;
  const rec = payload as Record<string, unknown>;
  if (!('answers' in rec)) return e;
  const { answers: _answers, ...rest } = rec;
  return { ...e, payload: rest };
}
