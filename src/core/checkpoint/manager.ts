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
import type { ArtifactStore } from '../artifact/types.js';
import type { ClockPort } from '../ports/clock.js';
import { ReplayAccumulator, replay, stateHashOf, type ReplayState } from './replay.js';
import {
  RollbackError,
  type ArtifactImpact,
  type Checkpoint,
  type CheckpointKind,
  type CheckpointSnapshot,
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
 *
 * ★★ v8：白名单分两段 —— **当前架构**与**历史事件**。
 *
 * ⚠️ 为什么要分段：v8 之前这里有 6 条（`route.decided` / `dispatch.*` /
 *    `conflict.*`）对应的功能**已经删了**，当前代码永不产生它们。
 *    但**不能删**：旧日志里有，删了回退历史会话时那些检查点会消失。
 *
 *    ★ 读到这里的人请注意：**历史段的存在不是"还有派发"的证据**。
 */
const CHECKPOINT_RULES: Partial<Record<SessionEvent['type'], { kind: CheckpointKind; label: (p: Record<string, unknown>) => string }>> = {
  // ── 当前架构（v8）────────────────────────────────────────────
  'thought.done': {
    kind: 'goal',
    label: (p) => (typeof p['stage'] === 'string' && p['stage'] === 'understand' ? '理解目标' : '推理完成'),
  },
  'memory.recalled': {
    kind: 'recall',
    label: (p) => `召回记忆 ${typeof p['count'] === 'number' ? p['count'] : 0} 条`,
  },
  /**
   * ★ v8 新增：**承诺了什么**。
   *
   * ⚠️ 这是新架构最该成为检查点的一步 —— 契约是监督员的核对标准，
   *    也是"回退到写契约之前重来"的锚点。之前它不成检查点，
   *    等于时间轴上缺了"它答应做什么"那一刻。
   */
  'contract.written': {
    kind: 'plan',
    label: (p) => {
      const n = Array.isArray(p['criteria']) ? p['criteria'].length : 0;
      const d = typeof p['deliverable'] === 'string' ? p['deliverable'] : '';
      return `写下契约${d.length > 0 ? `：${d.slice(0, 24)}` : ''}${n > 0 ? `（${n} 条判据）` : ''}`;
    },
  },
  /**
   * ★ v8 新增：**干完了**。
   *
   * ⚠️ 这是产出物的产生点，也是"回退到这一轮之前重来"的锚点。
   */
  'butler.executed': {
    kind: 'stepDone',
    label: (p) => {
      const st = typeof p['status'] === 'string' ? p['status'] : '?';
      const arts = typeof p['artifacts'] === 'number' ? p['artifacts'] : 0;
      return `执行完成（${st} · ${arts} 项产出）`;
    },
  },
  /** ★ v8 新增：**复核结果**（判据核对 + 三视角发现） */
  'supervisor.observe': {
    kind: 'verdict',
    label: (p) => {
      const met = typeof p['criteriaMet'] === 'number' ? p['criteriaMet'] : 0;
      const tot = typeof p['criteriaTotal'] === 'number' ? p['criteriaTotal'] : 0;
      const dropped = typeof p['droppedFindings'] === 'number' ? p['droppedFindings'] : 0;
      const tail = dropped > 0 ? ` · 丢弃 ${dropped} 条不规范发现` : '';
      return tot > 0 ? `复核完成（判据 ${met}/${tot}）${tail}` : `复核完成${tail}`;
    },
  },
  /** 硬约束机械拦截 —— 当前架构仍会产生 */
  'constraint.hardBlocked': { kind: 'conflict', label: () => '硬约束拦截' },
  'artifact.created': { kind: 'deliver', label: (p) => `产出物 ${String(p['label'] ?? p['artifactId'] ?? '')}` },
  'session.ended': { kind: 'deliver', label: () => '汇总交付' },

  // ── 历史事件（只读重放；当前代码**不再产生**）─────────────────
  //
  // ⚠️ 保留这 6 条只为**回退旧日志**时仍能重建当时的检查点。
  //    删了会让历史会话的时间轴突然变空。
  /** @deprecated 历史：独立路由调用已在 v8 砍掉（置信度并入契约） */
  'route.decided': { kind: 'route', label: (p) => `路由 → ${String(p['servant'] ?? '?')}` },
  /** @deprecated 历史：多步派发已删 */
  'dispatch.created': { kind: 'plan', label: (p) => `任务分解 ${Array.isArray(p['steps']) ? p['steps'].length : 0} 步` },
  /** @deprecated 历史：多步派发已删 */
  'dispatch.stepDone': {
    kind: 'stepDone',
    label: (p) => `完成 ${String(p['stepId'] ?? '?')}${p['servant'] ? ` · ${String(p['servant'])}` : ''}`,
  },
  /** @deprecated 历史：多步派发已删 */
  'dispatch.stepFailed': { kind: 'stepDone', label: (p) => `失败 ${String(p['stepId'] ?? '?')}` },
  /** @deprecated 历史：跨执行者冲突裁决已删（改为三视角复核） */
  'conflict.detected': { kind: 'conflict', label: () => '检出冲突' },
  /** @deprecated 历史：跨执行者冲突裁决已删 */
  'conflict.resolved': { kind: 'verdict', label: () => '冲突裁决' },
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
  /**
   * `sync()` 是否为新建的检查点落 `checkpoint.created` 事件。默认 true。
   *
   * ★ 什么情况下要传 false：**启动重放**。
   *
   *   ⚠️ 验证 7 抓到的问题：`bootstrap()` 里调 `sync()` 重建检查点，
   *      而这些检查点的 `checkpoint.created` 事件**历史里已经有了** ——
   *      再发一遍会让每次启动都往事件文件里写一批重复事件
   *      （实测：事件从 12 条涨到 16 条，且每次重启都涨）。
   *
   *   重放是**重建**，不是**变化** —— 重建不该产生新事件。
   */
  readonly emitCreatedEvents?: boolean;
}

export class CheckpointManager {
  private readonly checkpoints: Checkpoint[] = [];
  private readonly log: EventLog;
  private readonly clock: ClockPort;
  private artifactLabels: Map<string, string>;
  /** 见 CheckpointManagerOptions.emitCreatedEvents */
  private emitCreatedEvents: boolean;
  private counter = 0;

  constructor(opts: CheckpointManagerOptions) {
    this.log = opts.log;
    this.clock = opts.clock;
    this.artifactLabels = new Map(opts.artifactLabels ?? []);
    this.emitCreatedEvents = opts.emitCreatedEvents !== false;
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
   *
   * ★ 但派生结果本身也要落事件（`checkpoint.created`）—— 理由：
   *   `session.rollback` 事件会引用 `checkpointId`，
   *   若那个 id 在事件流里查不到，审计时就无法回答
   *   "这个检查点是何时、因何建立的"。
   *   派生视图不写事件，等于在真相源上留了个洞。
   *
   * ⚠️ 不会造成循环：`checkpoint.created` 本身**不在** CHECKPOINT_RULES 白名单里，
   *    所以它不会派生出新的检查点。
   */
  sync(): readonly Checkpoint[] {
    // ⚠️ 必须**两阶段**：先扫描完毕，再统一补落事件。
    //
    //    我第一版在遍历里直接 append，结果每次 append 都会改变 log.all() 的长度、
    //    并让 `existing` 判断失真 —— 实测事件数从 16 涨到 27（失控）。
    //    边界清晰的做法：扫描只读，写入延后。
    const existing = new Set(this.checkpoints.map((c) => c.seq));
    const pending: { readonly cp: Checkpoint; readonly sourceType: string }[] = [];

    /**
     * ★ 单次前向扫描，而不是"每个检查点重放一遍 1..seq"。
     *
     *   旧实现走 `snapshotAt(seq) → replay(range(1, seq))`，是 O(n²)，
     *   而 `replay()` 内部还会对整段事件算一次哈希（纯字符串化）。
     *   实测：本机 4,144 条事件 / 507 个检查点，启动 **24 秒**。
     *
     *   现在用一个累加器走一遍：单点快照从 O(n) 降到 O(1)，
     *   `usage` 也一起累加，不再为每个检查点重新求和。
     */
    const acc = new ReplayAccumulator();
    let inputTokens = 0;
    let outputTokens = 0;

    for (const e of this.log.all()) {
      acc.apply(e);

      const usage = (e.payload as { usage?: { inputTokens?: number; outputTokens?: number } } | null)
        ?.usage;
      if (usage) {
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
      }

      if (existing.has(e.seq)) continue;
      if (!isCheckpointWorthy(e)) continue;

      const cp = this.buildWith(e, acc.state(), { inputTokens, outputTokens });
      this.checkpoints.push(cp);
      existing.add(e.seq);
      pending.push({ cp, sourceType: e.type });
    }

    if (pending.length === 0) return [];

    this.checkpoints.sort((a, b) => a.seq - b.seq);
    this.revalidate();

    // 第二阶段：检查点本身落事件（让 session.rollback 引用的 id 可查）
    //
    // ⚠️ 启动重放时**不发** —— 这些事件历史里已经有了，
    //    再发一遍会让每次启动都往事件文件里写重复事件。
    if (!this.emitCreatedEvents) return pending.map((p) => p.cp);

    for (const { cp, sourceType } of pending) {
      this.log.append({
        type: 'checkpoint.created',
        actor: 'system',
        payload: {
          checkpointId: cp.id,
          label: cp.label,
          kind: cp.kind,
          atSeq: cp.seq,
          atEventType: sourceType,
          snapshot: {
            completedSteps: cp.snapshot.completedSteps.length,
            pendingSteps: cp.snapshot.pendingSteps.length,
            failedSteps: cp.snapshot.failedSteps.length,
            artifacts: cp.snapshot.artifacts.length,
            memories: cp.snapshot.memories.length,
          },
        },
        createdAt: cp.createdAt,
      });
    }

    return pending.map((p) => p.cp);
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

    /**
     * ⚠️ **历史分支**：`doneAfter` 只从 `dispatch.stepDone` 收集。
     *
     * ★ 当前架构不产生该事件 → `keepSteps` / `redoSteps` 对新会话本就是空的。
     *   **这不是 bug**：单执行者架构里没有「步骤」，回退粒度是**会话/产出物级**。
     *
     * ⚠️ 「每轮一个单元」的粒度尚未引入 —— 那是新功能设计（需要轮次 id），
     *    不属于「清掉仆人代码」。见 docs/refactor-status.md §7.3。
     */
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

    // 记忆层面：目标之后**新被依赖**的记忆需要复核
    // （它们是"回退掉的那段任务"里引入的，基于当时的信息产出）
    // ⚠️ 与 replay 保持同一套依赖语义：只有 constraint.injected 与
    //    servant.report.memoryRefs 算依赖。
    const keptMemories = new Set(target.snapshot.memories.map((m) => m.memoryId));
    const memoryImpact: { memoryId: string; action: 'keep' | 'review' }[] = [];
    for (const e of eventsAfter) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === 'constraint.injected') {
        /**
         * ★ 这是**当前架构**的记忆影响来源：`writeContract` 给每条注入的约束
         *   发一个 `constraint.injected`，所以「这轮用到了哪些记忆」照样算得出来。
         */
        const id = p['memoryId'];
        if (typeof id === 'string' && !keptMemories.has(id)) {
          memoryImpact.push({ memoryId: id, action: 'review' });
        }
      } else if (e.type === 'servant.report') {
        /**
         * ⚠️ **历史分支**（多执行者时代）：从 `servant.report.payload.memoryRefs` 取。
         *
         * 当前架构**不再产生** `servant.report`，所以这条分支在**新日志上不可达** ——
         * 记忆影响已由上面的 `constraint.injected` 覆盖。
         *
         * ★ 保留理由：**回退旧日志时仍需按当时的语义重建影响面**。
         *   删了会让历史检查点的 `memoryImpact` 变空。
         */
        const refs = p['memoryRefs'];
        if (Array.isArray(refs)) {
          for (const r of refs) {
            if (typeof r === 'string' && !keptMemories.has(r)) {
              memoryImpact.push({ memoryId: r, action: 'review' });
            }
          }
        }
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
   *
   * ★ 三方同步：如果提供了 `artifacts`，回退会同时把检查点之后产生的产出物
   *    标记为「已取代」—— 这样对话、任务状态、产出物三者回到同一个点。
   */
  rollback(targetId: string, options?: { readonly artifacts?: ArtifactStore }): RollbackResult {
    const plan = this.planRollback(targetId);
    const fromSeq = this.log.length;

    /**
     * ★ 一致性自检必须在**截断之前**做。
     *
     *   旧顺序是「先 truncateTo，再 replay + 比哈希」——
     *   一旦自检抛错，日志已经截断，而 `session.rollback` 事件还没落：
     *   磁盘上的历史没了，审计里也查不到"曾经回退过"。
     *
     *   ⚠️ 这个检查本身是**哨兵**，不是"状态与检查点快照比对"：
     *      `replay()` 内部的 stateHash 就是 `stateHashOf(events)`，
     *      所以正常情况下两者恒等。它存在的意义是——将来谁给 replay
     *      加了不确定性（读 Date.now、随机），这里会立刻炸出来。
     *      真正的语义校验由 `planRollback` 的产出物/记忆影响面负责。
     */
    const remaining = this.log.all().filter((e) => e.seq <= plan.toSeq);
    const replayed = replay(remaining);
    const expectedHash = stateHashOf(remaining);
    if (replayed.stateHash !== expectedHash) {
      throw new RollbackError(
        '重放状态哈希不一致，核心层可能混入了不确定因素（已中止，事件流未被截断）',
        'not_a_checkpoint_seq',
      );
    }

    const discardedEvents = this.log.truncateTo({
      sessionId: this.log.sessionId,
      seq: plan.toSeq,
      reason: `回退至检查点「${plan.target.label}」`,
    });

    const superseded = plan.artifactImpact
      .filter((a) => a.action === 'supersede')
      .map((a) => a.artifactId);
    const memoriesToReview = plan.memoryImpact
      .filter((m) => m.action === 'review')
      .map((m) => m.memoryId);

    // ★ 三方同步：把被取代的产出物在仓储里标记（不删除）
    if (options?.artifacts) {
      for (const id of superseded) {
        options.artifacts.supersede(id, { byRollback: plan.target.id });
      }
    }

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

  private buildWith(
    event: SessionEvent,
    state: ReplayState,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
  ): Checkpoint {
    const { kind, label } = labelFor(event);
    return {
      id: `ckpt_${event.seq}_${++this.counter}`,
      sessionId: event.sessionId,
      seq: event.seq,
      kind,
      label,
      detail: describeEvent(event),
      snapshot: this.snapshotFrom(state, usage),
      createdAt: event.createdAt,
    };
  }

  /** 把一份重放状态压成检查点快照（只存引用，不存内容）。 */
  private snapshotFrom(
    state: ReplayState,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
  ): CheckpointSnapshot {
    return {
      completedSteps: state.completedSteps,
      pendingSteps: state.pendingSteps,
      failedSteps: state.failedSteps,
      artifacts: state.artifactIds.map((id) => ({ artifactId: id, version: 1 })),
      memories: state.memoryIds.map((id) => ({ memoryId: id, version: 1 })),
      memoryCount: state.memoryIds.length,
      usage,
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

    // 只存引用（id + version）：内容由 replay 从事件流算出来，不会漂移。
    return this.snapshotFrom(r.state, { inputTokens: input, outputTokens: output });
  }
}

/** 为检查点生成一行说明。 */
function describeEvent(e: SessionEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    // ⚠️ `route.decided` / `dispatch.*` / `conflict.*` 是**历史事件**
    //    （当前代码不产生），保留只为给旧日志的检查点补一行说明。
    //    `constraint.hardBlocked` 仍在使用，所以它和 `conflict.detected` 共用分支。
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
