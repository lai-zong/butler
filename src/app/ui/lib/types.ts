/**
 * 界面看到的形状 —— 服务端投影（api/*）的 TypeScript 镜像
 *
 * ⚠️ 这里**刻意不 import 核心层的运行时模块**：
 *   界面只应依赖 HTTP 契约。核心类型若变化，先改 `app/server/uiData.ts`
 *   的投影，再同步这里 —— 这条边界让“服务端重构”不会把界面一起拖下水。
 */

export type ViewId = 'chat' | 'focus' | 'tasks' | 'memory' | 'growth' | 'settings';

/** 主界面：对话、专注空间、定时任务、设置；治理视图移入控制台。 */
export type MainView = 'chat' | 'focus' | 'tasks' | 'settings';

/** 控制台分区：记忆、演化，以及本程序自己的使用节奏。 */
export type ConsoleSection = 'memory' | 'growth' | 'usage';

/** 跳到记忆页时可携带的意图。 */
export interface MemoryTarget {
  readonly pending?: boolean;
  readonly lifecycle?: MemoryLifecycle;
  readonly id?: string;
  readonly q?: string;
}

/** 从其它空间跳到记忆页时携带的意图（只读取一次）。 */
export interface MemoryPreset {
  readonly nonce: number;
  readonly pending?: boolean;
  readonly lifecycle?: MemoryLifecycle;
  readonly id?: string;
  readonly q?: string;
}

// ═══════════════════════════════════════════════════════════
// 模型
// ═══════════════════════════════════════════════════════════

export interface ModelCapabilities {
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
  readonly supportsThinking: boolean;
}

export interface ModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
}

/** 随程序提供的本地模型资产：不是连接，不能填 Base URL / Key。 */
export type LocalModelKind = 'embedding' | 'rerank';

export interface LocalModelView {
  readonly id: string;
  readonly label: string;
  readonly kind: LocalModelKind;
  readonly source: 'local';
  readonly dimension: number | null;
  readonly available: boolean;
  readonly description: string;
}

// ═══════════════════════════════════════════════════════════
// 记忆
// ═══════════════════════════════════════════════════════════

export type MemoryClass = 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
export type MemoryKind = 'fact' | 'preference' | 'principle' | 'summary';
export type MemoryLifecycle = 'candidate' | 'active' | 'dormant' | 'archived';

export interface Effectiveness {
  readonly applied: number;
  readonly succeeded: number;
  readonly lastAppliedAt: number;
}

export interface PrincipleDetail {
  readonly condition: string;
  readonly action: string;
  readonly fromVerdict: string | null;
}

export interface MemoryItem {
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
  readonly effectiveness: Effectiveness | null;
  readonly principle: PrincipleDetail | null;
  readonly hasCredential: boolean;
  readonly grantCount: number;
  readonly mergedFrom: readonly string[];
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
  readonly fitnessBuckets: readonly number[];
}

export interface MemoryRevision {
  readonly id: string;
  readonly version: number;
  readonly reason: string;
  readonly actor: string;
  readonly createdAt: number;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

export interface MemoryListResponse {
  readonly ok: boolean;
  readonly items: readonly MemoryItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly stats: MemoryStats;
}

export interface MemoryConflictView {
  readonly memoryId: string;
  readonly otherMemoryId: string;
  readonly reason: string;
  readonly detector: string;
  readonly createdAt: number;
  readonly other: {
    readonly content: string;
    readonly memClass: string;
    readonly kind: string;
  };
}

export interface MemoryConflictsResponse {
  readonly ok: boolean;
  readonly conflicts: readonly MemoryConflictView[];
}

export interface MemoryDetailResponse {
  readonly ok: boolean;
  readonly item: MemoryItem;
  readonly revisions: readonly MemoryRevision[];
}

/**
 * 记忆关系图（只读派生投影）。
 *
 * 服务端不会持久化这张图：节点是记忆本身，边由内容相似、共享证据、
 * 冲突与合并来源实时推导。界面只消费这份投影，不新增真相源。
 */
export type MemoryEdgeType =
  | 'content'
  | 'semantic'
  | 'sharedEvidence'
  | 'conflict'
  | 'merge'
  | 'coRecall';

export interface MemoryGraphNode extends MemoryItem {
  readonly degree: number;
}

export interface MemoryGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: MemoryEdgeType;
  readonly weight: number;
  readonly reason?: string;
}

export interface MemoryGraphResponse {
  readonly ok: boolean;
  readonly nodes: readonly MemoryGraphNode[];
  readonly edges: readonly MemoryGraphEdge[];
  readonly total: { readonly nodes: number; readonly edges: number };
  readonly note: string;
}

// ═══════════════════════════════════════════════════════════
// 记忆变化记录
// ═══════════════════════════════════════════════════════════

/** 演化页的四条变化线索。 */
export type MemoryChangeKind = 'promotion' | 'archive' | 'conflict' | 'principle';

/** 变化发生时那条记忆的快照，够卡片引用与跳转即可。 */
export interface MemoryChangeMemory {
  readonly id: string;
  readonly subject: string | null;
  readonly content: string;
  readonly lifecycle: MemoryLifecycle;
  readonly kind: MemoryKind;
  readonly memClass: MemoryClass;
  readonly domain: string | null;
  readonly fitness: number;
  readonly confidence: number;
  readonly version: number;
}

/** 一次冲突：两种说法、是否裁决、留下了哪一边。 */
export interface MemoryChangeConflict {
  readonly candidateContent: string | null;
  readonly existingContent: string | null;
  readonly candidateId: string | null;
  readonly existingId: string | null;
  readonly resolved: boolean;
  readonly winner: 'new' | 'existing' | null;
  readonly winnerContent: string | null;
  readonly loserContent: string | null;
  readonly detectedAt: number;
  readonly resolvedAt: number | null;
}

/** 一条原则最近被用上的情况。 */
export interface MemoryChangePrinciple {
  readonly condition: string | null;
  readonly action: string | null;
  readonly applied: number;
  readonly appliedTotal: number;
  readonly effective: boolean | null;
  readonly effectNote: string | null;
}

export interface MemoryChange {
  readonly id: string;
  readonly seq: number;
  readonly at: number;
  readonly kind: MemoryChangeKind;
  readonly title: string;
  readonly summary: string;
  readonly note: string | null;
  readonly actor: string;
  readonly actorLabel: string;
  readonly memory: MemoryChangeMemory | null;
  readonly transition: {
    readonly from: MemoryLifecycle | null;
    readonly to: MemoryLifecycle;
  } | null;
  readonly conflict: MemoryChangeConflict | null;
  readonly principle: MemoryChangePrinciple | null;
}

export interface MemoryChangeCounts {
  readonly promotion: number;
  readonly archive: number;
  readonly conflict: number;
  readonly principle: number;
  readonly total: number;
}

export interface MemoryChangesResponse {
  readonly ok: boolean;
  readonly changes: readonly MemoryChange[];
  readonly counts: MemoryChangeCounts;
  /** 被展示的原则卡片中，最近实际被应用的次数总和。 */
  readonly applications: number;
  readonly window: {
    readonly from: number | null;
    readonly to: number | null;
    readonly days: number;
  };
  readonly truncated: boolean;
}

// ═══════════════════════════════════════════════════════════
// 会话
// ═══════════════════════════════════════════════════════════

export type ReasoningLevel = 'off' | 'low' | 'high' | 'max';
export type SessionMemoryMode = 'on' | 'off';
/** 会话工具权限；null 表示跟随应用默认（在 DTO 里用 permission 字段表达）。 */
export type SessionPermission = 'read-only' | 'workspace' | 'full';

/**
 * 会话设置投影。
 *
 * ★ 列表接口只给 `personaPreview`，`persona` 是 null；
 *   详情接口（GET /api/sessions/[id]）才给完整正文。
 *   编辑之前必须先取详情，避免把列表摘要当成正文保存回去。
 *
 * ★ workspace / permission 是**配置值**（null = 跟随应用）；
 *   effectiveWorkspace / effectivePermission 是服务端按应用当前默认解析后的
 *   实际值，界面直接用它们显示“当前实际”，不要在客户端自己猜。
 */
export interface SessionSettingsDto {
  readonly reasoning: ReasoningLevel;
  readonly memoryMode: SessionMemoryMode;
  readonly hasPersona: boolean;
  readonly personaLength: number;
  readonly personaPreview: string;
  readonly persona: string | null;
  readonly personaHash: string;
  readonly workspace: string | null;
  readonly permission: SessionPermission | null;
  readonly effectiveWorkspace: string;
  readonly effectivePermission: SessionPermission;
  readonly modelProfileId?: string;
  readonly modelId?: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly titleGenerated: boolean;
  readonly pinnedAt: number | null;
  readonly pinnedWorkspace: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly verdictCount: number;
  readonly lastPreview: string;
  readonly settings: SessionSettingsDto;
  readonly workspace: string | null;
  readonly permission: SessionPermission | null;
  readonly effectiveWorkspace: string;
  readonly effectivePermission: SessionPermission;
  readonly modelProfileId?: string;
  readonly modelId?: string;
  /** 桌宠专用会话：侧栏单独分区，默认不自动选中。 */
  readonly isPet?: boolean;
}

/** 详情接口比列表多一份完整人格正文（类型上收窄成 string）。 */
export interface SessionDetail extends Omit<SessionSummary, 'settings'> {
  readonly settings: SessionSettingsDto & { readonly persona: string };
}

export type SessionSettingsPatch = {
  readonly persona?: string;
  readonly reasoning?: ReasoningLevel;
  readonly memoryMode?: SessionMemoryMode | boolean;
  readonly workspace?: string | null;
  readonly permission?: SessionPermission | null;
  readonly modelProfileId?: string;
  readonly modelId?: string;
};

export type MessageRole = 'user' | 'butler' | 'servant' | 'system';
export type MessageStatus = 'done' | 'streaming' | 'interrupted' | 'failed';

export interface MemoryRef {
  readonly id: string;
  readonly content: string;
}

export interface ToolCallTrace {
  readonly callId: string;
  readonly name: string;
  readonly argsText: string;
  readonly ok: boolean;
  readonly denied: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export interface AgentTraceRound {
  readonly round: number;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCallTrace[];
}

export interface AgentTrace {
  readonly rounds: readonly AgentTraceRound[];
  /** 工具循环执行阶段累计用量（不含监督/反思）。 */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly finished: {
    readonly rounds: number;
    readonly reason: string;
  } | null;
}

export interface ExecutionReportArtifact {
  readonly kind: string;
  readonly text: string;
  readonly itemCount: number;
}

export interface ExecutionReportFinding {
  readonly kind: string;
  readonly statement: string;
  readonly evidence: readonly string[];
}

export interface InjectedConstraintView {
  readonly memoryId?: string;
  readonly content: string;
  readonly source: string;
  readonly negotiable: boolean;
}

export interface ExecutionReport {
  readonly servant: string;
  readonly taskId: string;
  readonly status: 'done' | 'failed' | 'blocked';
  readonly reply: string;
  readonly instruction: string;
  readonly agentTrace?: AgentTrace;
  readonly artifacts: readonly ExecutionReportArtifact[];
  readonly findings: readonly ExecutionReportFinding[];
  readonly uncertainties: readonly string[];
  readonly needsButlerDecision?: string;
  readonly injectedConstraints: readonly InjectedConstraintView[];
}

export interface MessageDto {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly servant: string | null;
  readonly servantLabel: string | null;
  readonly text: string;
  readonly reasoning: string | null;
  readonly reasoningTranslated: string | null;
  readonly status: MessageStatus;
  /** 仅中断/失败时有值：user_stopped / insufficient_balance / network / error */
  readonly interruptReason?: string | null;
  readonly createdAt: number;
  /** 刷新后本轮“依据”的事件范围；旧消息没有。 */
  readonly auditRange?: { readonly fromSeq: number; readonly toSeq: number };
  readonly memoryRefs: readonly MemoryRef[];
  readonly agentTrace: AgentTrace | null;
  readonly servantReports: readonly ExecutionReport[] | null;
}

export type VerdictSeverity = 'blocking' | 'advisory' | 'info';

export interface VerdictIssue {
  readonly severity: VerdictSeverity;
  readonly kind: string;
  readonly statement: string;
  readonly memoryId?: string;
  readonly memoryContent?: string;
  readonly suggestion?: string;
}

export interface CriteriaCheck {
  readonly criterion: string;
  readonly met: boolean;
  readonly note?: string;
}

export interface VerdictDto {
  readonly id: string;
  readonly sessionId: string;
  readonly forMessageId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly summary: string;
  readonly reviewed?: boolean;
  readonly issues: readonly VerdictIssue[];
  readonly criteriaChecks: readonly CriteriaCheck[];
  readonly steps: readonly { readonly stepId: string; readonly servant: string; readonly ok: boolean }[];
  readonly durationMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly sessionUsage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly artifactIds: readonly string[];
  readonly createdAt: number;
}

export interface QuizQuestion {
  readonly id: string;
  readonly stem: string;
  readonly options: readonly string[];
  readonly type?: 'choice' | 'short' | 'essay';
  readonly points?: number;
}

export interface QuizItemResult {
  readonly questionId: string;
  readonly stem: string;
  readonly picked?: string;
  readonly correct?: string;
  readonly right: boolean;
  readonly score?: number;
  readonly maxScore?: number;
  readonly feedback?: string;
  readonly reference?: string;
}

export interface QuizGrade {
  readonly total: number;
  readonly right: number;
  readonly items: readonly QuizItemResult[];
  readonly score?: number;
  readonly maxScore?: number;
}

export interface QuizItem {
  readonly id: number;
  readonly sessionId: string;
  readonly questions: readonly QuizQuestion[];
  readonly grade?: QuizGrade;
  /** 答案卷缺失（如从脱敏备份导入）时为 false */
  readonly gradable?: boolean;
}

export interface ReviewRunDto {
  readonly id: string;
  readonly sessionId: string;
  readonly turnIds: readonly string[];
  readonly status: 'running' | 'completed' | 'failed' | 'aborted';
  readonly model: string;
  readonly modelProfileId?: string;
  readonly modelId?: string;
  readonly promptVersion: string;
  readonly snapshotHash: string;
  readonly stages: readonly { readonly name: string; readonly status: 'done' | 'failed' }[];
  readonly report: {
    readonly criteriaChecks: readonly { readonly criterion: string; readonly met: boolean; readonly note?: string }[];
    readonly findings: readonly {
      readonly viewpoint: 'contract' | 'domain' | 'global';
      readonly severity: 'info' | 'warn' | 'block';
      readonly message: string;
      readonly evidence: readonly string[];
    }[];
    readonly summary: string;
  } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly error?: string;
  readonly createdAt: number;
}

export interface SessionCancellationDto {
  readonly id: string;
  readonly reason: string;
  readonly phase: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly createdAt: number;
}

export interface SessionDetailResponse {
  readonly ok: boolean;
  readonly session: SessionDetail;
  readonly messages: readonly MessageDto[];
  readonly verdicts: readonly VerdictDto[];
  readonly reviews?: readonly ReviewRunDto[];
  readonly quizzes: readonly QuizItem[];
  readonly cancellations?: readonly SessionCancellationDto[];
}

export interface SessionSettingsPatchResponse {
  readonly ok: boolean;
  readonly session: SessionDetail;
}

export interface SessionsResponse {
  readonly ok: boolean;
  readonly sessions: readonly SessionSummary[];
}

export interface SessionCreateResponse {
  readonly ok: boolean;
  readonly session: SessionSummary;
}

/** POST /api/sessions/:id/pin：时间模式用 pinnedAt，工作区模式用 pinnedWorkspace。 */
export interface SessionPinResponse {
  readonly ok: boolean;
  readonly pinnedAt: number | null;
  readonly pinnedWorkspace: string | null;
}

/**
 * POST /api/sessions/:id/title：懒生成短标题。
 * generated=false 表示模型没给出可用标题，界面保留第一句话兜底，不重试。
 */
export interface SessionTitleResponse {
  readonly ok: boolean;
  readonly generated: boolean;
  readonly title: string;
}

/** PATCH /api/sessions/:id/title：手动重命名；manual=true 后自动生成不再覆盖。 */
export interface SessionTitlePatchResponse {
  readonly ok: boolean;
  readonly title: string;
  readonly manual: boolean;
}

// ═══════════════════════════════════════════════════════════
// 审计
// ═══════════════════════════════════════════════════════════

export interface RecallItem {
  readonly memoryId: string;
  readonly memClass: string;
  readonly memClassLabel: string;
  readonly relevance: number;
  readonly relevancePercent: number;
  readonly forced: boolean;
}

export interface RecallEvidence {
  readonly seq: number;
  readonly at: number;
  readonly count: number;
  readonly items: readonly RecallItem[];
}

export interface InjectionEvidence {
  readonly seq: number;
  readonly at: number;
  readonly stepId: string;
  readonly domain: string;
  readonly domainLabel: string;
  readonly memoryId: string;
  readonly content: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly negotiable: boolean;
  readonly reason: string;
}

export interface HardCheckEvidence {
  readonly seq: number;
  readonly at: number;
  readonly outcome: 'blocked' | 'passed';
  readonly content: string;
  readonly constraintId: string;
  readonly unhandledBy: readonly string[];
  readonly unhandledByLabels: readonly string[];
  readonly deterministic: boolean;
  readonly note: string;
}

export interface GrantEvidence {
  readonly seq: number;
  readonly at: number;
  readonly kind: 'requested' | 'approved' | 'denied' | 'used' | 'expired';
  readonly kindLabel: string;
  readonly memoryId: string;
  readonly toDomain: string;
  readonly toDomainLabel: string;
  readonly taskId: string;
  readonly reason: string;
  readonly expired: boolean;
}

export interface WriteAttemptEvidence {
  readonly seq: number;
  readonly at: number;
  readonly actor: string;
  readonly memoryId: string;
  readonly reason: string;
  readonly rejected: boolean;
}

export interface TurnAudit {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly recalls: readonly RecallEvidence[];
  readonly injections: readonly InjectionEvidence[];
  readonly hardChecks: readonly HardCheckEvidence[];
  readonly grants: readonly GrantEvidence[];
  readonly writeAttempts: readonly WriteAttemptEvidence[];
  readonly summary: string;
}

export interface AuditResponse {
  readonly ok: boolean;
  readonly scope: 'session' | 'turn';
  readonly audit: TurnAudit;
  readonly hasContent: boolean;
}

export interface EventItem {
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

export interface EventsResponse {
  readonly ok: boolean;
  readonly items: readonly EventItem[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextBefore: number | null;
}

export interface RawEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: number;
  readonly parentEventId?: string;
  readonly actor: string;
  readonly servantId?: string;
}

// ═══════════════════════════════════════════════════════════
// 总览
// ═══════════════════════════════════════════════════════════

export interface DailyPoint {
  readonly key: string;
  readonly label: string;
  readonly total: number;
  readonly userMessages: number;
  readonly memories: number;
  readonly reflections: number;
  readonly toolCalls: number;
}

export interface ObservationState {
  readonly granted: boolean;
  readonly enabled: boolean;
  readonly grantedAt: number | null;
  readonly retentionDays: number;
  readonly recordedBlocks: number;
  readonly aggregates: number;
}

export interface Diagnostics {
  readonly sessionId: string;
  readonly userId: string;
  readonly startedAt: number;
  readonly uptimeMs: number;
  readonly dataDir: string;
  readonly eventsFile: string;
  readonly workspaceRoot: string;
  readonly eventsInMemory: number;
  readonly pendingPersistence: number;
  readonly resumed: boolean;
  readonly historicalEvents: number;
  readonly badLines: number;
  readonly issues: number;
  readonly issueDetails: readonly string[];
  readonly restored: {
    readonly memories: number;
    readonly artifacts: number;
    readonly operationMemories: number;
    readonly checkpoints: number;
    readonly chatSessions: number;
  };
  readonly allowWrite: boolean;
  readonly hasModel: boolean;
}

// ═══════════════════════════════════════════════════════════
// 使用节奏（GET / DELETE /api/usage，POST /api/usage/ping，
//           GET / PUT /api/usage/settings）
//
// ★ 只描述“用户如何使用本项目 Web 界面”：页面、时间、是否在操作。
//   没有工具、任务、消息、记忆或审查内容 —— 这些字段**永远不该**
//   出现在这里，接口也不接受它们。
//
// ★ 时长与习惯全部由服务端聚合（见 core/usage/aggregate.ts）：
//   界面只负责上报心跳和展示结果，不在客户端另算一套口径。
// ═══════════════════════════════════════════════════════════

/** 可上报的页面；控制台里的「使用节奏」页本身不参与统计。 */
export type UsagePageId = 'chat' | 'tasks' | 'settings' | 'memory' | 'growth';

export interface UsageDailyPoint {
  /** 本地日期，YYYY-MM-DD */
  readonly date: string;
  readonly minutes: number;
  readonly sessions: number;
}

export interface UsagePageStat {
  readonly id: UsagePageId;
  readonly label: string;
  readonly visits: number;
  readonly minutes: number;
}

export interface UsageHabit {
  readonly id: string;
  readonly text: string;
  /** 0–1 */
  readonly confidence: number;
  readonly observedDays: number;
}

export interface UsageResponse {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly days: number;
  /** 活跃分钟：页面可见、聚焦且最近有操作。 */
  readonly totalMinutes: number;
  /** 可见分钟：页面只是开着的时间也算。 */
  readonly visibleMinutes: number;
  readonly activeDays: number;
  readonly sessionCount: number;
  readonly avgSessionMinutes: number;
  readonly daily: readonly UsageDailyPoint[];
  readonly pages: readonly UsagePageStat[];
  readonly habits: readonly UsageHabit[];
  /** 当前区间内最早一次心跳；从未记录时为 null。 */
  readonly trackingSince: number | null;
}

/** POST /api/usage/ping 的响应；`recorded=false` 表示记录已关闭。 */
export interface UsagePingResponse {
  readonly ok: boolean;
  readonly recorded: boolean;
  readonly reason?: string;
}

export interface UsageSettingsResponse {
  readonly ok: boolean;
  readonly enabled: boolean;
}

// ═══════════════════════════════════════════════════════════
// 画像快照 / 成长对比（GET /api/profiles）
// ═══════════════════════════════════════════════════════════

export interface ProfileSummary {
  readonly id: string;
  readonly capturedAt: number;
  readonly sessionCount: number;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly temporalPatterns: number;
  readonly summary: string;
  readonly totalMemories: number;
}

export interface ProfilesResponse {
  readonly ok: boolean;
  readonly profiles: readonly ProfileSummary[];
  /** 旧版本只有计数、无法重建的快照事件数 */
  readonly skipped: number;
}

export interface ProfilePrinciple {
  readonly content: string;
  readonly confidence: number;
  readonly applied: number;
  readonly succeeded: number;
}

export interface ProfileSnapshotView {
  readonly id: string;
  readonly userId: string;
  readonly capturedAt: number;
  readonly sessionCount: number;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly perDomain: Readonly<Record<string, { readonly memories: number; readonly principles: number }>>;
  readonly temporalPatterns: number;
  readonly principleList: readonly ProfilePrinciple[];
  readonly summary: string;
}

export interface ProfileDeltaView {
  readonly from: ProfileSnapshotView;
  readonly to: ProfileSnapshotView;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly temporalPatterns: number;
  readonly totalMemories: number;
  readonly newPrinciples: readonly string[];
  readonly appliedPrinciples: readonly string[];
  readonly headline: string;
}

export interface ProfileDiffResponse {
  readonly ok: boolean;
  readonly delta: ProfileDeltaView;
}

// ═══════════════════════════════════════════════════════════
// 工具分级（GET /api/tools）
// ═══════════════════════════════════════════════════════════

export type ToolTier = 'readOnly' | 'normal' | 'highRisk' | 'dangerous';

export interface ToolTierView {
  readonly name: string;
  readonly description: string;
  readonly tier: ToolTier;
  readonly rung: 1 | 2 | 3 | 4 | null;
  readonly touchesCredentials: boolean;
  readonly actionApp: string | null;
  readonly source: 'native' | 'mcp';
}

export interface ToolsResponse {
  readonly ok: boolean;
  readonly mode: 'view' | 'workspace' | 'full' | null;
  readonly enabledTiers: Readonly<Record<ToolTier, boolean>>;
  readonly tools: readonly ToolTierView[];
}

// ═══════════════════════════════════════════════════════════
// 操作记忆（GET /api/operations）
// ═══════════════════════════════════════════════════════════

export type OperationKindView = 'method' | 'preference' | 'environment';

export interface OperationEffectivenessView {
  readonly attempts: number;
  readonly succeeded: number;
  readonly successRate: number;
  readonly lastUsedAt: number;
  readonly lastFailure: string | null;
  readonly avgDurationMs: number;
  readonly consecutiveFailures: number;
}

export interface OperationMemoryView {
  readonly id: string;
  readonly kind: OperationKindView;
  readonly kindLabel: string;
  readonly taskLabel: string;
  readonly taskSignature: string;
  readonly app: string | null;
  readonly content: string;
  readonly path: string | null;
  readonly pathLabel: string | null;
  readonly confidence: number;
  readonly effectiveness: OperationEffectivenessView | null;
  readonly summary: string;
  readonly evidenceCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OperationsResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly counts: Readonly<Record<OperationKindView, number>>;
  readonly apps: readonly string[];
  readonly operations: readonly OperationMemoryView[];
}

// ═══════════════════════════════════════════════════════════
// 产出物版本（GET /api/artifacts）
// ═══════════════════════════════════════════════════════════

export type ArtifactKindView = 'text' | 'list' | 'plan' | 'file' | 'code';
export type ArtifactStatusView = 'draft' | 'active' | 'superseded' | 'discarded';

export interface ArtifactSummaryView {
  readonly id: string;
  readonly label: string;
  readonly kind: ArtifactKindView;
  readonly status: ArtifactStatusView;
  readonly currentVersion: number;
  readonly producedByStep: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly supersededBy?: string;
  readonly supersededByRollback?: string;
  readonly revisionCount: number;
  readonly size: number;
}

export interface ArtifactsResponse {
  readonly ok: boolean;
  readonly artifacts: readonly ArtifactSummaryView[];
}

export interface ArtifactRevisionView {
  readonly artifactId: string;
  readonly version: number;
  readonly content: string;
  readonly items?: readonly string[];
  readonly author: 'servant' | 'butler' | 'user';
  readonly authorId?: string;
  readonly reason: string;
  readonly producedBy: readonly string[];
  readonly createdAt: number;
}

export interface RevisionDiffView {
  readonly artifactId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly addedLines: readonly string[];
  readonly removedLines: readonly string[];
  readonly unchangedCount: number;
}

export interface ArtifactDetailView {
  readonly ok: boolean;
  readonly artifact: {
    readonly id: string;
    readonly label: string;
    readonly kind: ArtifactKindView;
    readonly status: ArtifactStatusView;
    readonly currentVersion: number;
    readonly producedByStep: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly supersededBy?: string;
    readonly supersededByRollback?: string;
  };
  readonly revisions: readonly ArtifactRevisionView[];
  readonly currentVersion: number;
  readonly diff: RevisionDiffView | null;
}

export interface McpToolView {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly tier: string;
  readonly disabled: boolean;
}export interface McpServerView {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly enabled: boolean;
  readonly state: 'disconnected' | 'connecting' | 'connected' | 'failed' | 'disabled';
  readonly lastError: string | null;
  readonly command: string | null;
  readonly url: string | null;
  readonly envKeys: readonly string[];
  readonly vaultEnvKeys?: readonly string[];
  readonly policy: {
    readonly level: 'manual' | 'readOnly' | 'normal';
    readonly disabledTools: readonly string[];
    readonly allowMemoryWrite: boolean;
    readonly allowDangerousTools: boolean;
  };
  readonly notices: number;
  readonly tools: readonly McpToolView[];
}

export interface McpResponse {
  readonly ok: boolean;
  readonly configPath: string;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  readonly availableTransports: readonly string[];
  readonly servers: readonly McpServerView[];
  readonly registeredTools: number;
}

export interface CheckpointDto {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly invalidatedBy: string | null;
  readonly artifactRefs: readonly {
    readonly artifactId: string;
    readonly version: number;
    readonly label: string;
  }[];
  readonly memoryCount: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly completedSteps: number;
  readonly pendingSteps: number;
  readonly failedSteps: number;
}

export interface CheckpointPreviewDto {
  readonly toSeq: number;
  readonly discardedEvents: number;
  readonly artifactImpact: readonly {
    readonly artifactId: string;
    readonly label: string;
    readonly action: 'keep' | 'supersede';
  }[];
  readonly memoryImpact: readonly {
    readonly memoryId: string;
    readonly action: 'keep' | 'review';
  }[];
  readonly keepSteps: readonly string[];
  readonly redoSteps: readonly string[];
  readonly executable: boolean;
  readonly blockedReason: string | null;
}

export interface CheckpointsResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly total: number;
  readonly valid: number;
  readonly checkpoints: readonly CheckpointDto[];
}

export interface CheckpointPreviewResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly checkpoint: CheckpointDto;
  readonly preview: CheckpointPreviewDto;
}

export interface CheckpointRollbackResponse {
  readonly ok: boolean;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly discardedEvents: number;
  readonly superseded: readonly string[];
  readonly memoriesToReview: readonly string[];
  readonly reviewedMemories: number;
  readonly rolledBackAt: number;
}

export interface SchedulesResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly running: boolean;
  readonly tasks: readonly {
    readonly kind: string;
    readonly label: string;
    readonly schedule: string;
    readonly nextRunAt: number;
    readonly lastRunAt: number;
    readonly lastOutcome: 'succeeded' | 'failed' | 'skipped' | 'retrying' | null;
    readonly lastSummary: string | null;
    readonly lastError: string | null;
    readonly totalRuns: number;
    readonly failedRuns: number;
    readonly due: boolean;
    readonly costsTokens: boolean;
    readonly lastUsage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  }[];
  readonly recent: readonly {
    readonly seq: number;
    readonly at: number;
    readonly kind: string | null;
    readonly label: string;
    readonly outcome: 'succeeded' | 'failed' | 'skipped' | 'retrying' | null;
    readonly manual: boolean;
    readonly attempt: number | null;
    readonly summary: string | null;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  }[];
}

// ═══════════════════════════════════════════════════════════
// 专注空间 · 日程（GET/POST /api/focus/schedules，
//               PATCH/DELETE /api/focus/schedules/:id，
//               POST /api/focus/current）
//
// ★ 与 `/api/tasks` 的 UserTaskView 完全独立：
//   没有 kind / repeat / 执行结果，也不会触发 AI。
// ═══════════════════════════════════════════════════════════

export interface FocusScheduleDto {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly remind: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FocusSchedulesResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly currentId: string | null;
  readonly schedules: readonly FocusScheduleDto[];
}

export type FocusSchedulePayload = {
  readonly title?: string;
  readonly note?: string;
  readonly startAt?: number;
  readonly endAt?: number;
  readonly remind?: boolean;
};

export interface Overview {
  readonly ok: boolean;
  readonly now: number;
  readonly memory: MemoryStats;
  readonly sessions: readonly SessionSummary[];
  readonly totals: {
    readonly sessions: number;
    readonly messages: number;
    readonly verdicts: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly events: number;
    readonly toolCalls: number;
    readonly todayUserMessages: number;
    readonly todayVerdicts: number;
    readonly todayMemories: number;
    readonly daysSinceFirstEvent: number;
  };
  readonly daily: readonly DailyPoint[];
  readonly principles: readonly MemoryItem[];
  readonly summaries: readonly MemoryItem[];
  readonly recentEvolution: readonly EventItem[];
  readonly recentEvents: readonly EventItem[];
  readonly observation: ObservationState;
  readonly quiz: {
    readonly created: number;
    readonly graded: number;
    readonly lastScore: { readonly right: number; readonly total: number } | null;
  };
  readonly model: ModelInfo | null;
  readonly restoreSummary: string;
  readonly diagnostics: Diagnostics;
}

// ═══════════════════════════════════════════════════════════
// 对话流
// ═══════════════════════════════════════════════════════════

export interface ContractView {
  readonly deliverable: string;
  readonly criteria: readonly string[];
  readonly mustObey: readonly string[];
  readonly domains: readonly string[];
  readonly confidence: number;
  readonly clarifyingQuestion: string | null;
}

export interface AssumptionView {
  readonly domains: readonly string[];
  readonly confidence: number;
  readonly note: string;
  readonly wouldHaveAsked?: string;
}

export interface ReflectionView {
  readonly pendingReview: number;
  readonly admittedAutonomously: number;
  readonly skippedDuplicates: number;
  readonly failed: boolean;
  readonly failureReason: string | null;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly toolName: string;
  readonly tier: string;
  readonly summary: string;
  readonly preview?: string;
}

/** POST /api/chat/steer 的响应。 */
export interface SteerResponse {
  readonly ok: boolean;
  readonly queued: boolean;
  readonly cancelled: number;
}

export type SseEvent =
  | { readonly type: 'session'; readonly sessionId: string }
  | {
      readonly type: 'progress';
      readonly event: { readonly kind: 'stage'; readonly stage: string; readonly label: string };
    }
  | {
      readonly type: 'narration';
      readonly reasoning: string;
      readonly reasoningTranslated: string;
      readonly answer: string;
      readonly firstChunkMs: number | null;
      readonly done: boolean;
    }
  | { readonly type: 'agent'; readonly kind: 'round'; readonly round: number }
  | {
      readonly type: 'agent';
      readonly kind: 'reasoning' | 'text';
      readonly round: number;
      readonly accumulated: string;
    }
  | {
      readonly type: 'agent';
      readonly kind: 'toolCall';
      readonly round: number;
      readonly callId: string;
      readonly name: string;
      readonly argsDelta: string;
      readonly partial: boolean;
    }
  | {
      readonly type: 'agent';
      readonly kind: 'toolStarted';
      readonly round: number;
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: 'agent';
      readonly kind: 'toolResult';
      readonly round: number;
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly denied: boolean;
      readonly output: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'agent';
      readonly kind: 'finished';
      readonly rounds: number;
      readonly reason: string;
    }
  | {
      readonly type: 'usage';
      readonly round: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalInputTokens: number;
      readonly totalOutputTokens: number;
      readonly sessionInputTokens: number;
      readonly sessionOutputTokens: number;
    }
  | {
      readonly type: 'approval';
      readonly id: string;
      readonly toolName: string;
      readonly tier: string;
      readonly summary: string;
      readonly preview?: string;
    }
  /**
   * 服务端已接收一条运行中途消息。
   * 前端用它确认乐观展示的那条用户消息，避免重复渲染。
   */
  | { readonly type: 'steering'; readonly text: string }
  | { readonly type: 'user'; readonly messageId: string }
  | {
      readonly type: 'contract';
      readonly contract: ContractView | null;
      readonly assumption: AssumptionView | null;
      readonly injectedConstraints: readonly InjectedConstraintView[];
    }
  | { readonly type: 'reply'; readonly messageId: string; readonly text: string }
  | { readonly type: 'verdict'; readonly verdict: VerdictDto }
  | { readonly type: 'reflection'; readonly reflection: ReflectionView | null }
  | { readonly type: 'reports'; readonly reports: readonly ExecutionReport[] }
  | {
      readonly type: 'settings';
      readonly settings: {
        readonly reasoning: ReasoningLevel;
        /** 后端实际生效的档位；未知供应商/未发送时为 null。 */
        readonly reasoningApplied: ReasoningLevel | null;
        readonly reasoningStyle: string;
        readonly memoryMode: 'on' | 'shadow' | 'off';
        readonly personaSource: 'session' | 'request' | 'none';
        readonly personaLength: number;
        readonly globalAgents: {
          readonly hash: string;
          readonly length: number;
          readonly loaded: boolean;
        };
      };
    }
  | {
      readonly type: 'audit';
      readonly range: { readonly fromSeq: number; readonly toSeq: number };
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'done' };

// ═══════════════════════════════════════════════════════════
// 对话页的本地流状态
// ═══════════════════════════════════════════════════════════

export type LiveToolStatus = 'pending' | 'running' | 'ok' | 'denied' | 'error';

export interface LiveTool {
  callId: string;
  name: string;
  argsText: string;
  status: LiveToolStatus;
  output: string;
  durationMs: number | null;
}

export interface LiveRound {
  round: number;
  reasoning: string;
  text: string;
  tools: LiveTool[];
}

export type LiveStatus = 'waiting' | 'streaming' | 'done' | 'error' | 'aborted';

export interface LiveUsage {
  /** 本轮任务累计（跨工具轮次） */
  readonly turnInputTokens: number;
  readonly turnOutputTokens: number;
  /** 本会话累计（已完成轮次 + 本轮实时） */
  readonly sessionInputTokens: number;
  readonly sessionOutputTokens: number;
}

export interface LiveAssistant {
  text: string;
  narration: string;
  narrationReasoning: string;
  narrationTranslated: string;
  stages: readonly string[];
  rounds: LiveRound[];
  usage: LiveUsage | null;
  finished: { rounds: number; reason: string } | null;
  contract: ContractView | null;
  assumption: AssumptionView | null;
  injectedConstraints: readonly InjectedConstraintView[];
  verdict: VerdictDto | null;
  reports: readonly ExecutionReport[];
  reflection: ReflectionView | null;
  auditRange: { fromSeq: number; toSeq: number } | null;
  audit: TurnAudit | null;
  status: LiveStatus;
  error: string | null;
  firstChunkMs: number | null;
}

export interface LiveSteeringMessage {
  /** 本轮内的稳定序号，用作 React key（服务端不提供消息 id）。 */
  readonly seq: number;
  readonly text: string;
  /** 服务端已经通过 `steering` SSE 事件确认；false 只表示本地乐观展示。 */
  readonly delivered: boolean;
}

export interface LiveTurn {
  /**
   * 本轮开始时间。
   *
   * ★ 之前实时轮的时间戳是写死的「刚刚」，流跑几分钟也还是「刚刚」——
   *   用户没法判断这一轮到底开始了多久。这里记下真实起点。
   */
  startedAt: number;
  userText: string;
  images: readonly string[];
  /** 本轮运行中用户补充的消息；刷新后由历史消息提供，不再从这里重复。 */
  steering: readonly LiveSteeringMessage[];
  assistant: LiveAssistant;
}

export interface ToastMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: 'default' | 'success' | 'warning' | 'danger';
}

export interface CredentialMetaDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface CredentialsResponse {
  readonly credentials: readonly CredentialMetaDto[];
}

// ═══════════════════════════════════════════════════════════
// 知识库检索（GET/POST /api/knowledge/retrieval）
//
// 知识库有自己的检索模式、嵌入模型、重排开关与向量索引；
// 与记忆的模型角色**不是同一套设置**，这里只描述文档检索域。
// ═══════════════════════════════════════════════════════════

export type KnowledgeRetrievalMode = 'hybrid' | 'lexical' | 'semantic';

/** 知识库嵌入模型的当前选择：本地 BGE，或远程配置里的 embedding 模型。 */
export type KnowledgeEmbeddingView =
  | {
      readonly kind: 'builtin';
      readonly label: string;
      readonly dimension: number;
    }
  | {
      readonly kind: 'profile';
      readonly profileId: string;
      readonly modelId: string;
      readonly label: string;
      readonly dimension: number;
    };

/** 可选的嵌入模型；缺 Key 或未设维度时前端禁用。 */
export interface KnowledgeEmbeddingChoice {
  readonly kind: 'builtin' | 'profile';
  readonly label: string;
  readonly dimension: number;
  readonly profileId?: string;
  readonly modelId?: string;
  readonly profileName?: string;
  readonly baseUrl?: string;
  readonly hasKey?: boolean;
  readonly requiresKey?: boolean;
}

export interface KnowledgeRetrievalConfig {
  readonly version: 1;
  readonly mode: KnowledgeRetrievalMode;
  readonly embedding: KnowledgeEmbeddingView;
  readonly rerank: boolean;
}

export interface KnowledgeIndexStatus {
  readonly ready: boolean;
  readonly model: string | null;
  readonly dimension: number | null;
  readonly indexedChunks: number;
  readonly staleReason: string | null;
  readonly rebuiltAt: number | null;
}

export interface KnowledgeRetrievalStatus {
  readonly mode: KnowledgeRetrievalMode;
  readonly embedding: KnowledgeEmbeddingView;
  readonly rerank: boolean;
  /** 本地 cross-encoder 是否存在；false 时不应假装可以开启重排。 */
  readonly rerankAvailable: boolean;
  /** 实际执行重排的模型名（如 Xenova/bge-reranker-base）；没有时为空。 */
  readonly rerankModel: string | null;
  readonly semanticMin: number;
  readonly documents: number;
  readonly chunks: number;
  readonly index: KnowledgeIndexStatus;
}

/** GET 的响应。 */
export interface KnowledgeRetrievalResponse {
  readonly ok: boolean;
  readonly config: KnowledgeRetrievalConfig;
  readonly status: KnowledgeRetrievalStatus;
  readonly choices: readonly KnowledgeEmbeddingChoice[];
}

/** POST 的响应：设置类 action 会带回 choices，rebuild 只有 config/status。 */
export interface KnowledgeRetrievalMutationResponse {
  readonly ok: boolean;
  readonly config: KnowledgeRetrievalConfig;
  readonly status: KnowledgeRetrievalStatus;
  readonly choices?: readonly KnowledgeEmbeddingChoice[];
}

export type KnowledgeHitRetrieval = 'lexical' | 'semantic' | 'both';

export interface KnowledgeSearchHit {
  readonly documentId: string;
  readonly name: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly score: number;
  readonly retrieval: KnowledgeHitRetrieval;
  readonly semanticScore?: number;
  readonly rerankScore?: number;
}

/** GET /api/documents?q=... 的搜索响应。 */
export interface KnowledgeSearchResponse {
  readonly ok: boolean;
  readonly query: string;
  readonly hits: readonly KnowledgeSearchHit[];
  readonly mode: KnowledgeRetrievalMode;
  readonly fallbackReason: string | null;
  readonly rerankUsed: boolean;
}

export interface DocumentSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly createdAt: number;
  readonly chunkCount: number;
}

export interface DocumentChunkDto {
  readonly id: string;
  readonly index: number;
  readonly text: string;
}

export interface DocumentDetailDto extends DocumentSummaryDto {
  readonly sha256: string;
  readonly chunks: readonly DocumentChunkDto[];
}

export interface DocumentHitDto {
  readonly documentId: string;
  readonly name: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly score: number;
  /** 命中的来源：字面、语义，或两者都命中。 */
  readonly retrieval?: KnowledgeHitRetrieval;
  readonly semanticScore?: number;
  readonly rerankScore?: number;
}

export interface DocumentsResponse {
  readonly ok: boolean;
  readonly documents?: readonly DocumentSummaryDto[];
  readonly hits?: readonly DocumentHitDto[];
  readonly query?: string;
  /** 搜索响应里的检索模式与降级信息；列表响应没有。 */
  readonly mode?: KnowledgeRetrievalMode;
  readonly fallbackReason?: string | null;
  readonly rerankUsed?: boolean;
}

export interface DocumentIngestResponse {
  readonly ok: boolean;
  readonly document: DocumentSummaryDto;
  readonly duplicate: boolean;
  /** 文档已入库、但知识库索引更新失败时的提示。 */
  readonly indexWarning?: string;
}

export interface DocumentDetailResponse {
  readonly ok: boolean;
  readonly document: DocumentDetailDto;
}

// ═══════════════════════════════════════════════════════════
// 用户定时任务（GET/POST /api/tasks，PATCH/DELETE /api/tasks/:id）
//
// ★ 与设置里的「自动化」内置任务不是同一套数据：
//   这里只放用户自己建的提醒与工作，内置任务仍由 /api/schedules 管理。
// ═══════════════════════════════════════════════════════════

export type TaskKind = 'reminder' | 'work';
export type TaskRepeat = 'once' | 'daily' | 'weekly';
export type TaskStatus = 'active' | 'paused' | 'completed';
export type TaskPermission = 'read-only' | 'workspace' | 'full';
export type TaskLastOutcome = 'succeeded' | 'failed' | 'skipped';

export interface TaskScheduleView {
  readonly repeat: TaskRepeat;
  /** once 使用；绝对毫秒时间戳 */
  readonly dueAt: number | null;
  /** daily / weekly 使用，HH:mm */
  readonly timeOfDay: string | null;
  /** weekly 使用，0=周日 */
  readonly weekday: number | null;
}

export interface TaskModelChoice {
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

/** `GET /api/tasks` 的任务投影；`due` 由服务端按当前时间计算。 */
export interface UserTaskView {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: string;
  readonly note: string;
  readonly schedule: TaskScheduleView;
  readonly status: TaskStatus;
  readonly nextRunAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly instruction: string | null;
  readonly workspace: string | null;
  readonly permission: TaskPermission;
  readonly model: TaskModelChoice | null;
  readonly files: readonly string[];
  readonly snoozeUntil: number | null;
  readonly completedAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastOutcome: TaskLastOutcome | null;
  readonly lastSummary: string | null;
  readonly lastError: string | null;
  readonly due: boolean;
}

export interface TasksResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly tasks: readonly UserTaskView[];
}

/**
 * POST / PATCH 的响应。
 *
 * 返回的是任务本身（没有 `due`）；界面写完一律重新拉列表，
 * 所以这里只当作“写成功了”的凭据，不拿它去拼列表。
 */
export interface TaskMutationResponse {
  readonly ok: boolean;
  readonly task?: Omit<UserTaskView, 'due'>;
}

export interface WorkTaskResultView {
  readonly outcome: 'succeeded' | 'failed';
  readonly summary: string;
  readonly error?: string;
}

/** POST /api/tasks/:id/action 里 `run` 的响应；失败时 ok 为 false 但仍是 200。 */
export interface TaskRunResponse {
  readonly ok: boolean;
  readonly result?: WorkTaskResultView;
}

/** `/api/model` 的最小投影：只为了给工作挑一个对话模型。 */
export interface ModelChoiceProfileView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly {
    readonly id: string;
    readonly kind: 'chat' | 'embedding' | 'rerank';
  }[];
  readonly hasKey: boolean;
  readonly requiresKey?: boolean;
}

export interface ModelChoicesResponse {
  readonly ok: boolean;
  readonly profiles: readonly ModelChoiceProfileView[];
}

// ═══════════════════════════════════════════════════════════
// 网页桌宠（GET / PUT /api/pet/config）
//
// 设置页读写这些偏好；桌宠只存在于 Web 页面内，不再有独立进程。
// ═══════════════════════════════════════════════════════════

export type PetThinkingLevel = 'default' | 'low' | 'medium' | 'high';

/** 主动说话的频率上限；具体规则由服务端决定，界面只展示“少 / 正常 / 多”。 */
export type PetProactiveFrequency = 'rare' | 'normal' | 'often';

/** 服务端判定命中的主动场景。 */
export type PetProactiveTrigger = 'late_night' | 'long_session' | 'return';

export interface PetProactiveScenarios {
  readonly lateNight: boolean;
  readonly longSession: boolean;
  readonly return: boolean;
}

/** 桌宠用的模型；null = 跟随主界面当前对话模型。 */
export interface PetModelChoice {
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

export interface PetConfigView {
  readonly version: 1;
  /** 是否在 Web 界面显示桌宠。 */
  readonly enabled: boolean;
  /** 显示高度，120–480。 */
  readonly size: number;
  readonly sprite: string;
  readonly model: PetModelChoice | null;
  readonly thinkingLevel: PetThinkingLevel;
  /** 空字符串 = 默认管家；前端不回填默认提示词。 */
  readonly persona: string;
  /** 允许桌宠主动说话；默认关闭，由用户在桌宠设置里打开。 */
  readonly proactiveEnabled: boolean;
  /** 主动说话的频率上限；只控制能不能说，不改变人格措辞。 */
  readonly proactiveFrequency: PetProactiveFrequency;
  /** 安静时段（本地时间，HH:mm）；跨午夜同样有效。 */
  readonly quietStart: string;
  readonly quietEnd: string;
  /** 允许主动开口的场景；开关由服务端判定。 */
  readonly proactiveScenarios: PetProactiveScenarios;
  readonly updatedAt: number;
}

export interface PetAssetView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface PetConfigResponse {
  readonly ok: boolean;
  readonly config: PetConfigView;
  readonly assets: readonly PetAssetView[];
}

/**
 * GET /api/pet/session：网页桌宠的固定会话。
 * 首次调用时由服务端创建并写回 pet-config。
 */
export interface PetSessionResponse {
  readonly ok: boolean;
  readonly sessionId: string;
}

/**
 * POST /api/pet/proactive/claim：
 * 服务端按开关、频率、安静时段与场景决定要不要说话。
 * `text` 是平稳兜底句；人格只影响界面措辞，不影响这个决定。
 */
export interface PetProactiveClaimResponse {
  readonly ok: boolean;
  readonly shouldSpeak: boolean;
  readonly trigger?: PetProactiveTrigger;
  readonly text?: string;
  readonly cooldownUntil?: number | null;
  readonly reason?: string;
}

/** POST /api/pet/proactive/feedback：dismiss / snooze / mute。 */
export interface PetProactiveFeedbackResponse {
  readonly ok: boolean;
  readonly proactiveEnabled?: boolean;
  readonly snoozedUntil?: number;
}
