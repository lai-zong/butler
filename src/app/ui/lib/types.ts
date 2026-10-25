/**
 * 界面看到的形状 —— 服务端投影（api/*）的 TypeScript 镜像
 *
 * ⚠️ 这里**刻意不 import 核心层的运行时模块**：
 *   界面只应依赖 HTTP 契约。核心类型若变化，先改 `app/server/uiData.ts`
 *   的投影，再同步这里 —— 这条边界让“服务端重构”不会把界面一起拖下水。
 */

export type ViewId = 'chat' | 'memory' | 'audit' | 'growth' | 'settings';

/** 主界面只保留对话与设置；治理视图移入控制台。 */
export type MainView = 'chat' | 'settings';

/** 控制台内的三个治理分区。 */
export type ConsoleSection = 'memory' | 'audit' | 'growth';

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

// ═══════════════════════════════════════════════════════════
// 会话
// ═══════════════════════════════════════════════════════════

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly verdictCount: number;
  readonly lastPreview: string;
}

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
}

export interface QuizItemResult {
  readonly questionId: string;
  readonly stem: string;
  readonly picked?: string;
  readonly correct?: string;
  readonly right: boolean;
}

export interface QuizGrade {
  readonly total: number;
  readonly right: number;
  readonly items: readonly QuizItemResult[];
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
  readonly session: SessionSummary;
  readonly messages: readonly MessageDto[];
  readonly verdicts: readonly VerdictDto[];
  readonly reviews?: readonly ReviewRunDto[];
  readonly quizzes: readonly QuizItem[];
  readonly cancellations?: readonly SessionCancellationDto[];
}

export interface SessionsResponse {
  readonly ok: boolean;
  readonly sessions: readonly SessionSummary[];
}

export interface SessionCreateResponse {
  readonly ok: boolean;
  readonly session: SessionSummary;
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

export interface ActivityDetailResponse {
  readonly ok: boolean;
  readonly now: number;
  readonly consent: {
    readonly granted: boolean;
    readonly enabled: boolean;
    readonly grantedAt: number | null;
    readonly retentionDays: number;
  };
  readonly raw: readonly {
    readonly id: string;
    readonly app: string;
    readonly category: string;
    readonly categoryLabel: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly durationMs: number;
    readonly hadInput: boolean;
    readonly source: 'sample' | 'session' | 'demo';
  }[];
  readonly aggregates: readonly {
    readonly id: string;
    readonly userId: string;
    readonly bucket: string;
    readonly category: string;
    readonly minutes: number;
    readonly topApps: readonly string[];
  }[];
  readonly patterns: readonly {
    readonly id: string;
    readonly userId: string;
    readonly kind: 'routine' | 'preference' | 'availability';
    readonly pattern: string;
    readonly confidence: number;
    readonly evidence: readonly string[];
    readonly observedDays: number;
    readonly appliesTo: 'weekday' | 'weekend' | 'all';
    readonly createdAt: number;
  }[];
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
  readonly timeoutMs: number;
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
      readonly timeoutMs: number;
    }
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

export interface LiveTurn {
  userText: string;
  images: readonly string[];
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
}

export interface DocumentsResponse {
  readonly ok: boolean;
  readonly documents?: readonly DocumentSummaryDto[];
  readonly hits?: readonly DocumentHitDto[];
  readonly query?: string;
}

export interface DocumentDetailResponse {
  readonly ok: boolean;
  readonly document: DocumentDetailDto;
}
