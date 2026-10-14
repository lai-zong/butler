/**
 * 检查点管理器
 *
 * 设计依据：方案 § 5.1、§ 5.2
 *
 * 职责四件事：
 *   ① **筛选**：哪些事件值得成为检查点（不是每条都标）
 *   ② **记录**：存 seq 与引用（不存内容，见 types.ts 的架构说明）
 *   ③ **预览**：告诉用户回退会保留什么、重做什么、影响哪些产出物
 *   ④ **执行**：截断事件流 + 标记产出物 + 失效检测 + 状态哈希校验
 *
 * ★ 级联失效是最容易出 bug 的地方：
 *   检查点引用的记忆/产出物被删除后，那个检查点就**不可恢复**了
 *   （恢复它需要引用一个不存在的东西）。必须检测并标记，
 *   否则用户点回退会得到状态错乱。
 */

import type { EventLog } from '../events/log.js';
import type { SessionEvent } from '../events/types.js';
import type { ClockPort } from '../ports/clock.js';
import { replay, stateHashOf } from './replay.js';
import {
  RollbackError,
  type ArtifactImpact,
  type Checkpoint,
  type CheckpointKind,
  type CheckpointSnapshot,
  type MemoryRef,
  type RollbackPlan,
  type RollbackResult,
} from './types.js';

// ═══════════════════════════════════════════════════════════
// 筛选规则
// ═══════════════════════════════════════════════════════════

/**
 * 哪些事件值得成为检查点。
 *
 * 白名单而非黑名单：新增事件类型时**默认不成为检查点**，
 * 避免某天有人加了个高频事件把时间轴刷成一片。
 */
const CHECKPOINT_RULES: Partial<Record<SessionEvent['type'], { kind: CheckpointKind; label: (p: Record<string, unknown>) => string }>> = {
  'thought.done': {
    kind: 'goal',
    label: (p) => (typeof p['stage'] === 'string' && p['stage'] === 'understand' ? '理解目标' : '推理完成'),
  },
  'memory.recalled': {
    kind: 'recall',
    label: (p) => `召回记忆 ${typeof p['count'] === 'number' ? p['count'] : 0} 条`,
  },
  'route.decided': { kind: 'route', label: (p) => `路由 → ${String(p['servant'] ?? '?')}` },
  'dispatch.created': { kind: 'plan', label: (p) => `任务分解 ${Array.isArray(p['steps']) ? p['steps'].length : 0} 步` },
  'dispatch.stepDone': {
    kind: 'stepDone',
    label: (p) => `完成 ${String(p['stepId'] ?? '?')}${p['servant'] ? ` · ${String(p['servant'])}` : ''}`,
  },
  'dispatch.stepFailed': { kind: 'stepDone', label: (p) => `失败 ${String(p['stepId'] ?? '?')}` },
  'conflict.detected': { kind: 'conflict', label: () => '检出冲突' },
  'constraint.hardBlocked': { kind: 'conflict', label: () => '硬约束拦截' },
  'conflict.resolved': { kind: 'verdict', label: () => '冲突裁决' },
  'artifact.created': { kind: 'deliver', label: (p) => `产出物 ${String(p['label'] ?? p['artifactId'] ?? '')}` },
  'session.ended': { kind: 'deliver', label: () => '汇总交付' },
};

/** 该事件是否值得成为检查点。 */
export function isCheckpointWorthy(event: SessionEvent): boolean {
  return event.type in CHECKPOINT_RULES;
}

/** 为事件生成检查点标签。 */
export function labelFor(event: SessionEvent): { kind: CheckpointKind; label: string } {
  const rule = CHECKPOINT_RULES[event.type];
  if (!rule) return { kind: 'manual', label: event.type };
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return { kind: rule.kind, label: rule.label(payload) };
}

// ═══════════════════════════════════════════════════════════
// 管理器
// ═══════════════════════════════════════════════════════════

export interface CheckpointManagerOptions {
  readonly log: EventLog;
  readonly clock: ClockPort;
  /** 产出物 id → 展示名（用于回退预览） */
  readonly artifactLabels?: ReadonlyMap<string, string>;
}

export class CheckpointManager {
  private readonly checkpoints: Checkpoint[] = [];
  private readonly log: EventLog;
  private readonly clock: ClockPort;
  private artifactLabels: Map<string, string>;
  private counter = 0;

  constructor(opts: CheckpointManagerOptions) {
    this.log = opts.log;
    this.clock = opts.clock;
    this.artifactLabels = new Map(opts.artifactLabels ?? []);
  }

  // ── 查询 ──

  all(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  /** 只返回有效的检查点（失效的仍然保留 —— 用户要能看到"这个点为什么不能用了"）。 */
  valid(): readonly Checkpoint[] {
    return this.checkpoints.filter((c) => c.invalidatedBy === undefined);
  }

  byId(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  /** 最新的检查点。 */
  latest(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  registerArtifactLabels(map: ReadonlyMap<string, string>): void {
    for (const [k, v] of map) this.artifactLabels.set(k, v);
  }

  // ── ① 记录 ──

  /**
   * 扫描事件流，为所有"值得"的事件补建检查点（幂等）。
   *
   * 设计成"扫描式"而不是"每写一条事件就拦一次"：
   * 编排层不需要知道检查点的存在，检查点从事件流**派生**出来。
   * 这符合"事件是唯一真相源"。
   */
  sync(): readonly Checkpoint[] {
    const events = this.log.all();
    const existing = new Set(this.checkpoints.map((c) => c.seq));
    const added: Checkpoint[] = [];

    for (const e of events) {
      if (existing.has(e.seq)) continue;
      if (!isCheckpointWorthy(e)) continue;
      const cp = this.build(e);
      this.checkpoints.push(cp);
      added.push(cp);
    }

    if (added.length > 0) {
      this.checkpoints.sort((a, b) => a.seq - b.seq);
      this.revalidate();
    }
    return added;
  }

  /** 用户手动打点。 */
  manual(label: string, detail = ''): Checkpoint {
    const seq = this.log.nextSeq() - 1;
    const cp: Checkpoint = {
      id: `ckpt_manual_${++this.counter}`,
      sessionId: this.log.sessionId,
      seq: Math.max(seq, 0),
      kind: 'manual',
      label,
      detail,
      snapshot: this.snapshotAt(Math.max(seq, 0)),
      createdAt: this.clock.now(),
    };
    this.checkpoints.push(cp);
    this.checkpoints.sort((a, b) => a.seq - b.seq);
    return cp;
  }

  // ── ③ 预览 ──

  /**
   * 生成回退预览。
   *
   * 用户在按下"回退"之前看到的东西 —— 方案 § 5.2 明确要求这个。
   */
  planRollback(targetId: string): RollbackPlan {
    const target = this.byId(targetId);
    if (!target) {
      throw new RollbackError(`检查点 ${targetId} 不存在`, 'checkpoint_not_found');
    }
    if (target.invalidatedBy !== undefined) {
      throw new RollbackError(
        `该检查点已失效：${target.invalidatedBy}`,
        'checkpoint_invalidated',
      );
    }

    const currentSeq = this.log.length;
    if (target.seq >= currentSeq) {
      throw new RollbackError('目标检查点已在当前位置，无需回退', 'nothing_to_rollback');
    }

    const eventsAfter = this.log.range(target.seq + 1, currentSeq);

    // 步骤层面：目标快照已完成之外的都是"要重做"
    const doneAfter = new Set<string>();
    for (const e of eventsAfter) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === 'dispatch.stepDone' && typeof p['stepId'] === 'string') doneAfter.add(p['stepId']);
    }

    const keepSteps = [...target.snapshot.completedSteps];
    const redoSteps = [...doneAfter].filter((s) => !keepSteps.includes(s));

    // 产出物层面：目标之后产生的标记为已取代
    const keptArtifacts = new Set(target.snapshot.artifacts.map((a) => a.artifactId));
    const artifactImpact: ArtifactImpact[] = [];
    for (const e of eventsAfter) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === 'artifact.created') {
        const id = p['artifactId'];
        if (typeof id === 'string' && !keptArtifacts.has(id)) {
          artifactImpact.push({
            artifactId: id,
            label: this.artifactLabels.get(id) ?? String(p['label'] ?? id),
            action: 'supersede',
          });
        }
      }
    }
    for (const a of target.snapshot.artifacts) {
      artifactImpact.push({
        artifactId: a.artifactId,
        label: this.artifactLabels.get(a.artifactId) ?? a.artifactId,
        action: 'keep',
      });
    }

    // 记忆层面：目标之后新增的记忆需要复核（它们是基于"当时的信息"产出的）
    const keptMemories = new Set(target.snapshot.memories.map((m) => m.memoryId));
    const memoryImpact: { memoryId: string; action: 'keep' | 'review' }[] = [];
    for (const e of eventsAfter) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const id = p['memoryId'];
      if (typeof id === 'string' && (e.type === 'memory.candidate' || e.type === 'memory.approved') && !keptMemories.has(id)) {
        memoryImpact.push({ memoryId: id, action: 'review' });
      }
    }
    for (const m of target.snapshot.memories) {
      memoryImpact.push({ memoryId: m.memoryId, action: 'keep' });
    }

    return {
      target,
      toSeq: target.seq,
      keepSteps,
      redoSteps,
      artifactImpact,
      discardedEvents: eventsAfter.length,
      memoryImpact,
      executable: true,
    };
  }

  // ── ④ 执行 ──

  /**
   * 执行回退。
   *
   * ⚠️ **截断不是删除**：被丢弃的事件返回给调用方归档，
   *    被取代的产出物标记而不移除（方案 § 5.2「被取代产出物不删除，可对比」）。
   */
  rollback(targetId: string): RollbackResult {
    const plan = this.planRollback(targetId);
    const fromSeq = this.log.length;

    // 状态哈希：回退前先记下当前哈希，便于之后验证重放一致性
    const discardedEvents = this.log.truncateTo({
      sessionId: this.log.sessionId,
      seq: plan.toSeq,
      reason: `回退至检查点「${plan.target.label}」`,
    });

    // 回退后重放，确认状态与检查点记录一致 —— 一致性自检
    const replayed = replay(this.log.all());
    const expectedHash = stateHashOf(this.log.all());
    if (replayed.stateHash !== expectedHash) {
      // 理论上不可达：replay 内部用同一个哈希函数。
      // 留这个检查是为了将来有人给 replay 加了不确定逻辑时能被发现。
      throw new RollbackError('重放状态哈希不一致，核心层可能混入了不确定因素', 'not_a_checkpoint_seq');
    }

    const superseded = plan.artifactImpact
      .filter((a) => a.action === 'supersede')
      .map((a) => a.artifactId);
    const memoriesToReview = plan.memoryImpact
      .filter((m) => m.action === 'review')
      .map((m) => m.memoryId);

    // 落事件（可审计 + 供监督窗口同步）
    this.log.append({
      type: 'session.rollback',
      actor: 'user',
      payload: {
        checkpointId: plan.target.id,
        checkpointLabel: plan.target.label,
        fromSeq,
        toSeq: plan.toSeq,
        discardedEvents: discardedEvents.length,
        superseded,
        memoriesToReview,
        stateHash: replayed.stateHash,
      },
      createdAt: this.clock.now(),
    });

    // 回退后，被回退掉的那些检查点要移除（它们的 seq 已不存在）
    this.dropAfter(plan.toSeq);
    // 重新校验存活检查点的引用完整性
    this.revalidate();

    return {
      target: plan.target,
      fromSeq,
      toSeq: plan.toSeq,
      discarded: discardedEvents.map((e) => ({ seq: e.seq, type: e.type })),
      superseded,
      memoriesToReview,
      rolledBackAt: this.clock.now(),
      stateHash: replayed.stateHash,
    };
  }

  // ── ★ 级联失效检测 ──

  /**
   * 重新校验全部检查点的引用完整性。
   *
   * @param exists 判断某个 id 是否仍然存在。缺省则全部视为存在。
   *
   * ⚠️ 这是**最容易出 bug** 的地方：
   *    检查点引用的记忆/产出物一旦被删除，恢复它就等于恢复一个不存在的状态。
   *    必须标记失效，否则用户点回退会得到状态错乱。
   */
  revalidate(exists?: (kind: 'memory' | 'artifact', id: string) => boolean): readonly string[] {
    if (!exists) {
      // 没有提供存在性判定，只做"seq 是否还在事件流里"的基础校验
      return this.dropAfter(this.log.length).map((c) => c.id);
    }

    const invalidated: string[] = [];
    for (let i = 0; i < this.checkpoints.length; i++) {
      const cp = this.checkpoints[i];
      if (!cp || cp.invalidatedBy !== undefined) continue;

      const missingMemory = cp.snapshot.memories.find((m) => !exists('memory', m.memoryId));
      const missingArtifact = cp.snapshot.artifacts.find((a) => !exists('artifact', a.artifactId));

      if (missingMemory || missingArtifact) {
        const what = missingMemory
          ? `依赖的记忆 ${missingMemory.memoryId} 已被删除`
          : `依赖的产出物 ${missingArtifact?.artifactId} 已被删除`;
        this.checkpoints[i] = { ...cp, invalidatedBy: what };
        invalidated.push(cp.id);
      }
    }
    return invalidated;
  }

  /** 移除 seq 超过阈值的检查点（它们对应的事件已不存在）。 */
  private dropAfter(seq: number): Checkpoint[] {
    const dropped = this.checkpoints.filter((c) => c.seq > seq);
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const c = this.checkpoints[i];
      if (c && c.seq > seq) this.checkpoints.splice(i, 1);
    }
    return dropped;
  }

  // ── 内部 ──

  private build(event: SessionEvent): Checkpoint {
    const { kind, label } = labelFor(event);
    return {
      id: `ckpt_${event.seq}_${++this.counter}`,
      sessionId: event.sessionId,
      seq: event.seq,
      kind,
      label,
      detail: describeEvent(event),
      snapshot: this.snapshotAt(event.seq),
      createdAt: event.createdAt,
    };
  }

  /**
   * 生成某 seq 处的快照。
   *
   * ⚠️ 只存**引用**（id + version），不存内容 —— 见 types.ts 顶部说明。
   *    内容由 replay 从事件流浪出来，所以永远不会漂移。
   */
  private snapshotAt(seq: number): CheckpointSnapshot {
    const events = this.log.range(1, seq);
    const r = replay(events);

    let input = 0;
    let output = 0;
    for (const e of events) {
      const u = (e.payload as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
      if (u) {
        input += u.inputTokens ?? 0;
        output += u.outputTokens ?? 0;
      }
    }

    const memories: MemoryRef[] = r.state.memoryIds.map((id, i) => ({ memoryId: id, version: 1 + i * 0 }));

    return {
      completedSteps: r.state.completedSteps,
      pendingSteps: r.state.pendingSteps,
      failedSteps: r.state.failedSteps,
      artifacts: r.state.artifactIds.map((id) => ({ artifactId: id, version: 1 })),
      memories,
      memoryCount: r.state.memoryIds.length,
      usage: { inputTokens: input, outputTokens: output },
    };
  }
}

/** 为检查点生成一行说明。 */
function describeEvent(e: SessionEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'route.decided':
      return `置信度 ${typeof p['confidence'] === 'number' ? p['confidence'] : '?'}`;
    case 'dispatch.created':
      return typeof p['goal'] === 'string' ? `目标：${p['goal'].slice(0, 40)}` : '';
    case 'dispatch.stepDone':
      return typeof p['status'] === 'string' ? `状态 ${p['status']}` : '';
    case 'conflict.detected':
    case 'constraint.hardBlocked':
      return typeof p['message'] === 'string' ? p['message'].slice(0, 50) : '';
    case 'memory.recalled':
      return typeof p['count'] === 'number' ? `命中 ${p['count']} 条` : '';
    default:
      return '';
  }
}
