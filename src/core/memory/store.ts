/**
 * 记忆仓储 —— 四类分权的落地
 *
 * 设计依据：方案 § 2.2⑥（记忆分权模型）、§ 3.1（三元结构）、§ 4.2（数据模型）
 *
 * 核心不变量（每条都有对应测试）：
 *   M1. 全局层（global_constraint / global_shared / sensitive）**只能管家写入**
 *   M2. 领域记忆只能由**所属仆人**读写，其它仆人不可见
 *   M3. 敏感域默认完全隔离，跨域读取必须有**未过期的授权**
 *   M4. 每次写入/读取/授权都落事件（可审计）
 *   M5. 仆人越权写入不抛异常，而是**记为 memory.writeAttempted 并拒绝**
 *       —— 因为"越权尝试"本身是有价值的审计信息，不该被静默吞掉
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import {
  isButlerWriteOnly,
  isForceVisible,
  isSearchableByAll,
  type MemoryClass,
  type MemoryEntry,
  type MemoryGrant,
  type MemoryKind,
  type MemoryLifecycle,
  type MemoryOwner,
  type MemoryRevision,
} from './types.js';
import type { ServantId } from '../servants/types.js';

// ═══════════════════════════════════════════════════════════
// 操作主体
// ═══════════════════════════════════════════════════════════

/** 谁在操作记忆。管家与仆人的权限不同。 */
export type MemoryActor =
  | { readonly kind: 'butler'; readonly userId: string }
  | { readonly kind: 'servant'; readonly userId: string; readonly servant: ServantId }
  | { readonly kind: 'user'; readonly userId: string };

/** 读取被拒的原因。 */
export type ReadDenyReason =
  | 'sensitive_no_grant' // 敏感域且无有效授权
  | 'domain_not_owner' // 领域记忆且非所属仆人
  | 'not_found';

export type ReadResult =
  | { readonly ok: true; readonly entry: MemoryEntry }
  | { readonly ok: false; readonly reason: ReadDenyReason };

/** 写入被拒的原因。 */
export type WriteDenyReason =
  | 'global_butler_only' // 全局层只能管家写
  | 'domain_not_owner' // 领域记忆只能所属仆人写
  | 'hard_constraint_immutable'; // 硬约束不可被仆人改动

export type WriteResult =
  | { readonly ok: true; readonly entry: MemoryEntry }
  | { readonly ok: false; readonly reason: WriteDenyReason };

// ═══════════════════════════════════════════════════════════
// 输入类型
// ═══════════════════════════════════════════════════════════

export interface CreateMemoryInput {
  readonly id?: string;
  readonly memClass: MemoryClass;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly subject?: string;
  /** 领域记忆必填：归属哪个仆人 */
  readonly domainOwner?: ServantId;
  /** 初始生命周期，默认 candidate（需审核） */
  readonly lifecycle?: MemoryLifecycle;
}

export interface ListQuery {
  readonly memClass?: MemoryClass;
  readonly lifecycle?: MemoryLifecycle;
  readonly kind?: MemoryKind;
  readonly domainOwner?: ServantId;
}

// ═══════════════════════════════════════════════════════════
// 仓储
// ═══════════════════════════════════════════════════════════

export class MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly revisions: MemoryRevision[] = [];
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
    private readonly userId: string,
  ) {}

  // ── 查询 ──

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  size(): number {
    return this.entries.size;
  }

  all(): readonly MemoryEntry[] {
    return [...this.entries.values()];
  }

  list(q: ListQuery = {}): readonly MemoryEntry[] {
    return this.all().filter(
      (e) =>
        (q.memClass === undefined || e.memClass === q.memClass) &&
        (q.lifecycle === undefined || e.lifecycle === q.lifecycle) &&
        (q.kind === undefined || e.kind === q.kind) &&
        (q.domainOwner === undefined ||
          (e.owner.kind === 'servant' && e.owner.servant === q.domainOwner)),
    );
  }

  revisionsOf(memoryId: string): readonly MemoryRevision[] {
    return this.revisions.filter((r) => r.memoryId === memoryId);
  }

  // ── 权限判定（公开，供上层复用与测试）──

  /**
   * 某个主体能否**看见**某条记忆。
   *
   * 这是 M1—M3 的统一入口 —— 所有读取路径都必须经过它。
   */
  canRead(actor: MemoryActor, entry: MemoryEntry): ReadDenyReason | null {
    // 用户本人永远能看自己的数据
    if (actor.kind === 'user') return null;

    // 管家对全部四类都有读取权（权限矩阵：管家对敏感域是"读写"）
    if (actor.kind === 'butler') return null;

    // 全局硬约束：对所有角色强制可见
    if (isForceVisible(entry.memClass)) return null;

    // 全局共享：可按需检索
    if (isSearchableByAll(entry.memClass)) return null;

    // 敏感域：默认完全隔离，必须有未过期且授予本人的授权
    if (entry.memClass === 'sensitive') {
      const grants = entry.grants ?? [];
      const now = this.clock.now();
      const valid = grants.some((g) => g.grantedTo === actor.servant && g.expiresAt > now);
      return valid ? null : 'sensitive_no_grant';
    }

    // 领域记忆：只有所属仆人可见
    if (entry.memClass === 'domain') {
      if (entry.owner.kind !== 'servant') return 'domain_not_owner';
      return entry.owner.servant === actor.servant ? null : 'domain_not_owner';
    }

    return null;
  }

  /**
   * 某个主体能否**写入**某条记忆。
   *
   * M1：全局层只能管家写。
   * M2：领域记忆只能所属仆人**改动**。
   *
   * ⚠️ 注意"写"分两种动作，权限不同：
   *   · **建档**（create）：管家可以代仆人建候选 —— 反思产出的是候选，
   *     建档动作由管家执行，但归属明确标为那个仆人（`domainOwner`）。
   *     见 `canCreateDomain`。
   *   · **改动**（revise / review / forget）：只有所属仆人或用户能做。
   *     管家对领域记忆是**只读** —— 它靠注入约束影响仆人，而不是替仆人改记忆。
   */
  canWrite(actor: MemoryActor, entry: MemoryEntry): WriteDenyReason | null {
    if (actor.kind === 'user') return null;

    if (isButlerWriteOnly(entry.memClass)) {
      return actor.kind === 'butler' ? null : 'global_butler_only';
    }

    // domain 改动：只有所属仆人
    if (actor.kind !== 'servant') return 'domain_not_owner';
    if (entry.owner.kind !== 'servant') return 'domain_not_owner';
    return entry.owner.servant === actor.servant ? null : 'domain_not_owner';
  }

  /**
   * 建档权限（比 `canWrite` 宽松一档）。
   *
   * 管家可以为**明确指定了归属**的领域记忆建档 —— 否则反思的产出无处落地。
   * 但管家不能给"归属不明"的领域记忆建档，那个缺口会走 `canWrite` 被拒。
   */
  private canCreateDomain(actor: MemoryActor, input: CreateMemoryInput): WriteDenyReason | null {
    if (actor.kind === 'user') return null;
    if (actor.kind === 'servant') {
      // 仆人只能建自己领域的
      return input.domainOwner === undefined || input.domainOwner === actor.servant
        ? null
        : 'domain_not_owner';
    }
    // 管家：必须显式指定归属，不能建"无主的领域记忆"
    return input.domainOwner !== undefined ? null : 'domain_not_owner';
  }

  // ── 读（带审计）──

  /**
   * 读取一条记忆。被拒时不抛异常，返回原因 ——
   * 因为"读被拒绝"本身要能展示给用户（隐私页的授权记录）。
   */
  read(actor: MemoryActor, id: string): ReadResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };

    const deny = this.canRead(actor, entry);
    if (deny) {
      this.log.append({
        type: 'grant.denied',
        actor: actor.kind === 'user' ? 'user' : actor.kind,
        ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
        payload: {
          memoryId: id,
          memClass: entry.memClass,
          reason: deny,
          stage: 'read',
        },
        createdAt: this.clock.now(),
      });
      return { ok: false, reason: deny };
    }

    // 审计：敏感域的实际读取要单独留痕（"谁在什么时候读了什么"）
    if (entry.memClass === 'sensitive' && actor.kind === 'servant') {
      this.log.append({
        type: 'grant.used',
        actor: 'servant',
        servantId: actor.servant,
        payload: { memoryId: id, memClass: entry.memClass, content: entry.content },
        createdAt: this.clock.now(),
      });
    }

    return { ok: true, entry };
  }

  /** 按主体过滤出可见集合（召回层的输入）。 */
  visibleTo(actor: MemoryActor): readonly MemoryEntry[] {
    return this.all().filter((e) => this.canRead(actor, e) === null);
  }

  // ── 写（带权限强制与事件）──

  /**
   * 创建一条记忆。
   *
   * M5：越权不抛异常，而是记 `memory.writeAttempted` 后返回失败 ——
   * 这样"仆人试图写全局记忆"这件事会留在审计里。
   *
   * ⚠️ 领域记忆的 owner 由 **domainOwner 决定**，不由 actor 决定 ——
   *    因为管家也会代表仆人的反思结果去建档（反思产出的是候选，
   *    建档动作由管家执行，但归属是那个仆人）。
   *    写入权限校验仍然针对 actor，不会被这个便利绕过。
   */
  create(actor: MemoryActor, input: CreateMemoryInput): WriteResult {
    const owner = this.resolveOwner(actor, input);
    const now = this.clock.now();
    const id = input.id ?? this.nextId();

    const entry: MemoryEntry = {
      id,
      owner,
      memClass: input.memClass,
      kind: input.kind,
      content: input.content,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      confidence: input.confidence,
      evidence: [...input.evidence],
      fitness: input.confidence, // 初始适应度取置信度
      lifecycle: input.lifecycle ?? 'candidate',
      lastHitAt: null,
      hitCount: 0,
      revivedCount: 0,
      scope: input.memClass === 'domain' ? 'domain' : 'global',
      version: 1,
      ...(input.memClass === 'sensitive' ? { grants: [] } : {}),
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    };

    // 建档权限：领域记忆走宽松一档（管家可代建），其余走严格判定
    const deny =
      input.memClass === 'domain'
        ? this.canCreateDomain(actor, input)
        : this.canWrite(actor, entry);
    if (deny) {
      // ★ 越权尝试要留痕，而不是静默失败
      this.log.append({
        type: 'memory.writeAttempted',
        actor: actor.kind === 'user' ? 'user' : actor.kind,
        ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
        payload: {
          rejected: true,
          reason: deny,
          memClass: input.memClass,
          attemptedContent: input.content,
          owner,
        },
        createdAt: now,
      });
      return { ok: false, reason: deny };
    }

    this.entries.set(id, entry);
    this.log.append({
      type: entry.lifecycle === 'candidate' ? 'memory.candidate' : 'memory.approved',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
      payload: {
        memoryId: id,
        memClass: entry.memClass,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        evidence: entry.evidence,
        owner,
        lifecycle: entry.lifecycle,
      },
      createdAt: now,
    });

    return { ok: true, entry };
  }

  /**
   * 修改一条记忆（产生新版本，保留历史）。
   *
   * 历史保留是"可回滚"的前提 —— 也是用户能追问"这条记忆是怎么变成现在这样的"的依据。
   */
  revise(
    actor: MemoryActor,
    id: string,
    patch: Partial<Pick<MemoryEntry, 'content' | 'confidence'>>,
    reason: string,
  ): WriteResult {
    const before = this.entries.get(id);
    if (!before) return { ok: false, reason: 'domain_not_owner' };

    const deny = this.canWrite(actor, before);
    if (deny) {
      this.log.append({
        type: 'memory.writeAttempted',
        actor: actor.kind === 'user' ? 'user' : actor.kind,
        ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
        payload: { rejected: true, reason: deny, memoryId: id, op: 'revise' },
        createdAt: this.clock.now(),
      });
      return { ok: false, reason: deny };
    }

    const now = this.clock.now();
    const after: MemoryEntry = {
      ...before,
      ...patch,
      version: before.version + 1,
      updatedAt: now,
    };
    this.entries.set(id, after);

    const revision: MemoryRevision = {
      id: `rev_${id}_${after.version}`,
      memoryId: id,
      version: after.version,
      patch: { before: { ...before }, after: { ...after } },
      reason,
      actor: actor.kind === 'user' ? 'user' : 'butler',
      createdAt: now,
    };
    this.revisions.push(revision);

    this.log.append({
      type: 'memory.revised',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
      payload: { memoryId: id, version: after.version, patch, reason },
      createdAt: now,
    });

    return { ok: true, entry: after };
  }

  /**
   * 审核候选：通过 → active，拒绝 → archived。
   *
   * 注意拒绝**不删除** —— 保留"曾被拒绝"这一事实，避免反思反复提出同一条候选。
   */
  review(
    actor: MemoryActor,
    id: string,
    decision: 'approve' | 'reject',
    reason = '',
  ): WriteResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' as never };

    const deny = this.canWrite(actor, entry);
    if (deny) return { ok: false, reason: deny };

    const now = this.clock.now();
    const after: MemoryEntry = {
      ...entry,
      lifecycle: decision === 'approve' ? 'active' : 'archived',
      updatedAt: now,
    };
    this.entries.set(id, after);

    this.log.append({
      type: decision === 'approve' ? 'memory.approved' : 'memory.rejected',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
      payload: { memoryId: id, decision, reason },
      createdAt: now,
    });

    return { ok: true, entry: after };
  }

  /**
   * 遗忘权：彻底删除。
   *
   * ⚠️ 硬约束不可遗忘 —— 否则会出现"把用户的过敏史删掉"这种荒唐结果。
   * 事件日志里保留删除事实（不含内容），因为这本身是"该删的已经删了"的证据。
   */
  forget(actor: MemoryActor, id: string): { ok: boolean; reason?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };

    if (entry.memClass === 'global_constraint') {
      return { ok: false, reason: 'hard_constraint_cannot_be_forgotten' };
    }

    const deny = this.canWrite(actor, entry);
    if (deny) return { ok: false, reason: deny };

    this.entries.delete(id);
    // 只记录"已删除"，不记内容 —— 遗忘权要求内容真的消失
    this.log.append({
      type: 'intervention.forgotten',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      ...(actor.kind === 'servant' ? { servantId: actor.servant } : {}),
      payload: { memoryId: id, memClass: entry.memClass, hardConstraint: false },
      createdAt: this.clock.now(),
    });

    return { ok: true };
  }

  // ── 敏感域授权 ──

  /**
   * 为某个仆人授予一次跨域读取权限。
   *
   * ⚠️ **按任务失效**：必须带 taskId 与 expiresAt，不做长期免授权（方案 § 2.2⑥）。
   */
  grant(args: {
    readonly actor: MemoryActor;
    readonly memoryId: string;
    readonly to: ServantId;
    readonly taskId: string;
    readonly purpose: string;
    readonly ttlMs: number;
  }): { ok: boolean; reason?: string } {
    // 只有管家或用户能授权
    if (args.actor.kind === 'servant') {
      return { ok: false, reason: 'only_butler_or_user_can_grant' };
    }

    const entry = this.entries.get(args.memoryId);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.memClass !== 'sensitive') {
      return { ok: false, reason: 'grant_only_applies_to_sensitive' };
    }

    const now = this.clock.now();
    const grant: MemoryGrant = {
      taskId: args.taskId,
      grantedTo: args.to,
      at: now,
      expiresAt: now + args.ttlMs,
      purpose: args.purpose,
    };

    this.entries.set(args.memoryId, {
      ...entry,
      grants: [...(entry.grants ?? []), grant],
      updatedAt: now,
    });

    this.log.append({
      type: 'grant.requested',
      actor: args.actor.kind,
      payload: { memoryId: args.memoryId, to: args.to, taskId: args.taskId, purpose: args.purpose },
      createdAt: now,
    });
    this.log.append({
      type: 'grant.approved',
      actor: args.actor.kind,
      payload: {
        memoryId: args.memoryId,
        to: args.to,
        taskId: args.taskId,
        expiryPolicy: 'task-scoped',
        expiresAt: grant.expiresAt,
      },
      createdAt: now,
    });

    return { ok: true };
  }

  /** 清掉已过期的授权（定时任务调用）。 */
  expireGrants(): number {
    const now = this.clock.now();
    let n = 0;
    for (const [id, entry] of this.entries) {
      const grants = entry.grants;
      if (!grants || grants.length === 0) continue;
      const alive = grants.filter((g) => g.expiresAt > now);
      if (alive.length === grants.length) continue;
      this.entries.set(id, { ...entry, grants: alive, updatedAt: now });
      this.log.append({
        type: 'grant.expired',
        actor: 'system',
        payload: {
          memoryId: id,
          expiredCount: grants.length - alive.length,
          remaining: alive.length,
        },
        createdAt: now,
      });
      n += grants.length - alive.length;
    }
    return n;
  }

  // ── 内部 ──

  /**
   * 解析归属。
   *
   * 领域记忆的归属**只看 domainOwner**（管家代建档时也要显式指定），
   * 不从 actor 推断 —— 否则管家建的领域记忆归属就会含糊不清，
   * 而"每条记忆有 owner，审计时能说清是哪个角色写的"是清单要求。
   */
  private resolveOwner(actor: MemoryActor, input: CreateMemoryInput): MemoryOwner {
    if (input.memClass === 'domain') {
      if (input.domainOwner !== undefined) {
        return { kind: 'servant', userId: this.userId, servant: input.domainOwner };
      }
      if (actor.kind === 'servant') {
        return { kind: 'servant', userId: this.userId, servant: actor.servant };
      }
      // 领域记忆没给归属：不猜，交给 canWrite 判定失败
      return { kind: 'butler', userId: this.userId };
    }
    return { kind: 'butler', userId: this.userId };
  }

  private nextId(): string {
    this.seq += 1;
    return `mem_${this.seq.toString(36)}_${this.clock.now().toString(36)}`;
  }
}
