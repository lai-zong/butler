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
import { hashContent } from '../events/scrub.js';
import { snapshotOf } from './snapshot.js';
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
  type Effectiveness,
  type MemoryOwner,
  type MemoryRevision,
  type PrincipleDetail,
} from './types.js';
import type { DomainId } from '../domain/types.js';

// ═══════════════════════════════════════════════════════════
// 操作主体
// ═══════════════════════════════════════════════════════════

/** 谁在操作记忆。管家与仆人的权限不同。 */
export type MemoryActor =
  | { readonly kind: 'butler'; readonly userId: string; readonly taskId?: string }
  | { readonly kind: 'user'; readonly userId: string };

/** 授权 TTL 上限：任务级授权不应变成长期免授权。 */
export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
/** 授权 TTL 下限（测试/极短任务仍可验证）。 */
export const MIN_GRANT_TTL_MS = 1_000;

/** 读取被拒的原因。 */
export type ReadDenyReason =
  | 'sensitive_no_grant' // 敏感域且无有效授权
  | 'not_found';

export type ReadResult =
  | { readonly ok: true; readonly entry: MemoryEntry }
  | { readonly ok: false; readonly reason: ReadDenyReason };

/** 写入被拒的原因。 */
export type WriteDenyReason =
  | 'global_butler_only' // 全局层只能管家写
  | 'hard_constraint_immutable' // 硬约束不可被改动
  /**
   * ⚠️ 这条是**后补的** —— 原先漏了它。
   *
   *   症状：`review()` 里要返回 `not_found`，但类型里没有这个值，
   *   于是写成了 `'not_found' as never`（用断言压住类型系统的合法投诉）。
   *
   *   ⚠️ 同一类值在别处是**正常使用**的（`forget()` 就写了 `'not_found'`）——
   *      因为那个方法的返回类型是宽松的 `{ ok: boolean; reason?: string }`。
   *      也就是说：**类型越精确的地方，越容易用断言绕过，而不是补全类型**。
   *      而断言是静默的：类型系统不再保护这一处，也没人知道。
   */
  | 'not_found';

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
  /**
   * 领域标签（v7）。字段名是历史命名，语义已从「归属哪个仆人」变为「关于哪个领域」。
   * 改名（→ `domain`）归入 A2b。
   */
  readonly domain?: DomainId;
  /** 初始生命周期，默认 candidate（需审核） */
  readonly lifecycle?: MemoryLifecycle;
}

export interface ListQuery {
  readonly memClass?: MemoryClass;
  readonly lifecycle?: MemoryLifecycle;
  readonly kind?: MemoryKind;
  readonly domain?: DomainId;
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

  // ── 重放注入（仅供重放器使用）──

  /**
   * 直接注入一条记忆的完整状态。
   *
   * ★ 为什么不能用 `create()` 重放：
   *   `create()` 会**发事件** —— 重放时用它会把历史事件再发一遍，
   *   事件流被污染，且下一次重放会翻倍。
   *
   *   所以重放必须走一条**不发事件**的注入路径。
   *
   * ⚠️ 只应由 `replayMemoryStore()` 调用。业务代码用 `create()`。
   */
  restoreEntry(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
  }

  /** 注入一条版本历史（详情见 MemoryRevision）。 */
  restoreRevision(revision: MemoryRevision): void {
    this.revisions.push(revision);
  }

  /** 全部版本历史（重放器用来做等价性校验）。 */
  allRevisions(): readonly MemoryRevision[] {
    return this.revisions;
  }

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
        (q.domain === undefined ||
          (e.domain === q.domain)),
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
   *
   * ★★ v7（A2）关键改动：**敏感域检查提到了"管家直接放行"之前**。
   *
   * ═══ 为什么必须提前（这是一处真实的安全漏洞）═══
   *
   *   旧顺序：
   *     ① user  → 放行
   *     ② butler → **放行全部**     ← 敏感域检查在它后面，永远轮不到
   *     ③ 硬约束/共享 → 放行
   *     ④ sensitive → 需要有授权
   *
   *   旧架构里这个顺序是"对的"，因为敏感域的隔离对象是**仆人**：
   *   管家本来就该能读全部，仆人必须持授权。
   *
   *   ⚠️ 但单执行者下**没有仆人了**，所有读取都走管家那一条 →
   *     第 ④ 步**永远不执行** → **敏感域隔离变成空壳**。
   *
   *   ★ 而 D-8 讨论时已经确认过这条产品判断：
   *     「哪怕只有一个 Agent，用户也不希望心理记录出现在买菜建议的上下文里。
   *       隔离的对象从来不是'哪个仆人'，而是'哪类任务该加载哪些记忆'。」
   *
   *   所以正确顺序是：**敏感域先拦，谁都不例外**（用户本人除外）。
   */
  canRead(actor: MemoryActor, entry: MemoryEntry): ReadDenyReason | null {
    // 用户本人永远能看自己的数据
    if (actor.kind === 'user') return null;

    // ── 敏感域：默认完全隔离，必须有未过期的任务授权 ──
    //
    // ⚠️ **这一段必须在"管家放行"之前** —— 理由见上方注释。
    //    这是安全核心：删掉或挪后，敏感域隔离就会静默失效。
    if (entry.memClass === 'sensitive') {
      const grants = entry.grants ?? [];
      const now = this.clock.now();
      // ★ v7：任务范围由 `taskId` 界定，有效性由 `expiresAt` 保证。
      //   ⚠️ v10.4：必须同时匹配当前任务的 taskId —— 只检查“有过授权”
      //   会让任务 A 的敏感授权泄漏给任务 B。
      const valid = grants.some(
        (g) => g.expiresAt > now && actor.taskId !== undefined && g.taskId === actor.taskId,
      );
      if (!valid) return 'sensitive_no_grant';
      return null;
    }

    // 管家对其余三类有读取权
    if (actor.kind === 'butler') return null;

    // 全局硬约束：对所有角色强制可见
    if (isForceVisible(entry.memClass)) return null;

    // 全局共享：可按需检索
    if (isSearchableByAll(entry.memClass)) return null;

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
   *     建档动作由管家执行，但归属明确标为那个仆人（`domain`）。
   *     见 `canCreateDomain`。
   *   · **改动**（revise / review / forget）：只有所属仆人或用户能做。
   *     管家对领域记忆是**只读** —— 它靠注入约束影响仆人，而不是替仆人改记忆。
   */
  canWrite(actor: MemoryActor, entry: MemoryEntry): WriteDenyReason | null {
    if (actor.kind === 'user') return null;

    if (isButlerWriteOnly(entry.memClass)) {
      return actor.kind === 'butler' ? null : 'global_butler_only';
    }

    return null;
  }

  /**
   * 建档权限（比 `canWrite` 宽松一档）。
   *
   * 管家可以为**明确指定了归属**的领域记忆建档 —— 否则反思的产出无处落地。
   * 但管家不能给"归属不明"的领域记忆建档，那个缺口会走 `canWrite` 被拒。
   */
  private canCreateDomain(_actor: MemoryActor, _input: CreateMemoryInput): WriteDenyReason | null {
    return null;
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
    if (entry.memClass === 'sensitive' && actor.kind === 'butler') {
      this.log.append({
        type: 'grant.used',
        actor: 'butler',
        payload: {
          memoryId: id,
          memClass: entry.memClass,
          taskId: actor.taskId,
        },
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
   * ⚠️ 领域记忆的 owner 由 **domain 决定**，不由 actor 决定 ——
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
      /**
       * ★ v7（A2 前置步）：把领域标签**真的写进 entry**。
       *
       * ⚠️ 这是一个必要的中间状态：
       *   · 旧代码用 `owner.servant` 当"领域标识"（去重、合并、原则过滤都靠它）
       *   · 本步先把同一信息写进独立的 `domain` 字段
       *   · **下一步**才把所有读取 `owner.servant` 的地方改为读 `domain`
       *   · 再下一步才删 `owner.servant`
       *
       * 分三步的理由：任何一步单独出问题都能独立定位，
       * 而且**中间状态的行为与改造前完全一致**（两个字段同值）。
       */
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
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
      payload: {
        memoryId: id,
        memClass: entry.memClass,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        evidence: entry.evidence,
        owner,
        lifecycle: entry.lifecycle,
        /**
         * ⚠️ 这条事件**也**要带 snapshot。
         *
         *   我第一版只给 `review()` 路径加了 snapshot，于是「建档即 active」
         *   发出的那条 `memory.approved` 没有 —— 重放时被判为"信息不足"跳过。
         *   验证 6 直接抓到了它（报告 13 条被跳过）。
         *
         *   教训：**同一个事件类型被两条路径使用时，两条都要带齐字段**。
         *   否则重放会得到"部分正确"的状态 —— 而部分正确是最难查的。
         */
        snapshot: snapshotOf(entry),
        decidedBy: actor.kind === 'user' ? 'user' : 'system',
        audit: entry.lifecycle === 'candidate' ? 'candidateCreated' : 'created',
      },
      createdAt: now,
    });

    // ★★ `memory.created` —— 专用于**重建**的完整状态快照。
    //
    //   ⚠️ 上面那条 `memory.candidate` / `memory.approved` 是**语义事件**
    //      （回答"这条记忆是怎么来的"），字段刻意为审计服务，
    //      **缺 fitness / createdAt / version / subject / principle 等**，
    //      不足以重建出等价的 MemoryEntry。
    //
    //      两者职责不同，都需要：
    //        · 语义事件 → 审计、界面展示、用户理解"它为什么记下这条"
    //        · 状态事件 → 重放重建（本事件）
    //
    //   这也是"事件是唯一真相源"能成立的前提：
    //   真相源必须包含**足以重建状态**的信息，否则重放会得到残缺的状态。
    this.log.append({
      type: 'memory.created',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      payload: {
        /**
         * 完整条目 —— 重放器直接用它恢复，不做任何推断。
         *
         * ⚠️ 用 `snapshotOf` 而不是手抄字段：
         *   手抄时漏掉 `domain` 会导致**重启后领域标签消失**（实测踩过），
         *   而这类缺口不会被类型检查发现 —— 它只是 payload 里少一个键。
         */
        entry: snapshotOf(entry) ?? {},
        // 便于界面与日志快速读取（不必解包 entry）
        memoryId: id,
        memClass: entry.memClass,
        kind: entry.kind,
        content: entry.content,
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
    if (!before) return { ok: false, reason: 'not_found' };

    const deny = this.canWrite(actor, before);
    if (deny) {
      this.log.append({
        type: 'memory.writeAttempted',
        actor: actor.kind === 'user' ? 'user' : actor.kind,
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
    /**
     * 审核的元信息。
     *
     * ★ `decidedBy: 'system'` 表示这是**系统自主**决定的（分级准入），
     *   不是用户点的。审计时必须能区分这两者 ——
     *   它们的安全含义完全不同：一个是用户授权，一个是系统自判。
     */
    meta?: {
      readonly decidedBy?: 'user' | 'system';
      readonly source?: string;
      readonly sourceLabel?: string;
      readonly audit?: string;
    },
  ): WriteResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };

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
      payload: {
        memoryId: id,
        decision,
        reason,
        // ★ 状态快照 —— 让重放能精确恢复（decision 改变了 lifecycle）
        snapshot: snapshotOf(after),
        decidedBy: meta?.decidedBy ?? (actor.kind === 'user' ? 'user' : 'system'),
        ...(meta?.source !== undefined ? { source: meta.source } : {}),
        ...(meta?.sourceLabel !== undefined ? { sourceLabel: meta.sourceLabel } : {}),
        /**
         * ⚠️ `memory.approved` 被两处使用：
         *   · 建档时 lifecycle 就是 active（新记忆直接生效）
         *   · 审核候选通过
         *
         *   统计与界面需要区分它们，所以带一个 `audit` 标记。
         *   没有这个标记的老事件按 `created` 处理（建档）。
         */
        audit: meta?.audit ?? (entry.lifecycle === 'candidate' ? 'review' : 'created'),
        // 用户随时可以撤销 —— 这是「自主生效不等于失控」的落点
        revocable: true,
      },
      createdAt: now,
    });

    return { ok: true, entry: after };
  }

  /**
   * 遗忘权：彻底删除。
   *
   * ⚠️ 硬约束不可遗忘 —— 否则会出现"把用户的过敏史删掉"这种荒唐结果。
   *
   * ★ v9：这次删除必须能**扛过重启与导出/导入**。
   *   之前只做了"从内存表删掉 + 记一条删除事件"，重放只认 `memory.created`，
   *   于是关掉应用再打开，删掉的记忆会原样回来（实测确认过）。
   *   现在同时做三件事：
   *     ① 删条目、删版本历史；
   *     ② 写墓碑（只留 id / 分类 / 内容哈希，不留原文）；
   *     ③ 抹掉历史事件里引用了这条记忆的原文（`log.scrubForMemory`），
   *        重写文件后，审计页与导出文件里也不会再有原文。
   */
  forget(actor: MemoryActor, id: string): { ok: boolean; reason?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };

    if (entry.memClass === 'global_constraint') {
      return { ok: false, reason: 'hard_constraint_cannot_be_forgotten' };
    }

    const deny = this.canWrite(actor, entry);
    if (deny) return { ok: false, reason: deny };

    const content = entry.content;
    this.entries.delete(id);
    // 版本历史里也有 patch.before/after（可能带原文），一并删掉。
    const kept = this.revisions.filter((r) => r.memoryId !== id);
    this.revisions.splice(0, this.revisions.length, ...kept);

    this.log.append({
      type: 'intervention.forgotten',
      actor: actor.kind === 'user' ? 'user' : actor.kind,
      payload: {
        memoryId: id,
        memClass: entry.memClass,
        hardConstraint: false,
        erased: true,
        // 只留指纹：能证明"曾经有过这段内容"，但不能还原。
        contentHash: hashContent(content),
      },
      createdAt: this.clock.now(),
    });

    // ★ 顺序：先写墓碑（seq 更大），再抹除更早事件里的原文。
    //   重写会带上墓碑，不会把它弄丢。
    this.log.scrubForMemory(id, content);

    return { ok: true };
  }

  // ── 敏感域授权 ──

  /**
   * 为某个任务授予一次敏感域读取权限。
   *
   * ⚠️ **按任务失效**：必须带 taskId 与 expiresAt，不做长期免授权（方案 § 2.2⑥）。
   */
  grant(args: {
    readonly actor: MemoryActor;
    readonly memoryId: string;
    readonly to: DomainId;
    readonly taskId: string;
    readonly purpose: string;
    readonly ttlMs: number;
  }): { ok: boolean; reason?: string; expiresAt?: number } {
    // 只有管家或用户能授权（类型已限定；这里保留运行时防线）
    if (args.actor.kind !== 'user' && args.actor.kind !== 'butler') {
      return { ok: false, reason: 'actor_not_allowed' };
    }
    if (args.taskId.trim().length === 0) {
      return { ok: false, reason: 'task_required' };
    }
    if (args.purpose.trim().length === 0) {
      return { ok: false, reason: 'purpose_required' };
    }
    if (
      !Number.isFinite(args.ttlMs) ||
      args.ttlMs < MIN_GRANT_TTL_MS ||
      args.ttlMs > MAX_GRANT_TTL_MS
    ) {
      return { ok: false, reason: 'ttl_out_of_range' };
    }

    const entry = this.entries.get(args.memoryId);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.memClass !== 'sensitive') {
      return { ok: false, reason: 'grant_only_applies_to_sensitive' };
    }

    const now = this.clock.now();
    const grant: MemoryGrant = {
      taskId: args.taskId.trim(),
      grantedTo: args.to,
      at: now,
      expiresAt: now + args.ttlMs,
      purpose: args.purpose.trim(),
    };

    this.entries.set(args.memoryId, {
      ...entry,
      grants: [...(entry.grants ?? []), grant],
      updatedAt: now,
    });

    this.log.append({
      type: 'grant.requested',
      actor: args.actor.kind,
      payload: {
        memoryId: args.memoryId,
        to: args.to,
        toServant: args.to,
        taskId: grant.taskId,
        purpose: grant.purpose,
      },
      createdAt: now,
    });
    this.log.append({
      type: 'grant.approved',
      actor: args.actor.kind,
      payload: {
        memoryId: args.memoryId,
        to: args.to,
        toServant: args.to,
        taskId: grant.taskId,
        expiryPolicy: 'task-scoped',
        expiresAt: grant.expiresAt,
      },
      createdAt: now,
    });

    return { ok: true, expiresAt: grant.expiresAt };
  }

  /**
   * 任务结束时撤销该任务的授权（不是等 TTL 到期）。
   *
   * 这是任务级授权的另一半：只靠 expiresAt 不够，任务提前结束时应立即失效。
   */
  revokeGrantsForTask(taskId: string): number {
    const target = taskId.trim();
    if (target.length === 0) return 0;

    const now = this.clock.now();
    let removed = 0;
    for (const [id, entry] of this.entries) {
      const grants = entry.grants;
      if (!grants || grants.length === 0) continue;
      const alive = grants.filter((g) => g.taskId !== target);
      if (alive.length === grants.length) continue;
      const count = grants.length - alive.length;
      removed += count;
      this.entries.set(id, { ...entry, grants: alive, updatedAt: now });
      this.log.append({
        type: 'grant.expired',
        actor: 'system',
        payload: {
          memoryId: id,
          reason: 'task_ended',
          taskId: target,
          expiredCount: count,
          remaining: alive.length,
        },
        createdAt: now,
      });
    }
    return removed;
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

  // ── 演化引擎专用（内部）──

  /**
   * 写入适应度与命中统计。
   *
   * ⚠️ **这是系统内部操作，不经过 canWrite**。
   *    理由：演化是系统自身的行为（actor = 'system'），不是某个角色的写操作。
   *    用户对演化的干预走 `EvolutionEngine.adjustWeight`，那条路径有显式审计事件。
   *
   * 之所以放在 store 而不是让引擎直接改对象：entry 是不可变对象，
   * 必须由 store 统一替换，否则 Map 里的引用会与外部视图不一致。
   */
  setFitness(
    memoryId: string,
    fitness: number,
    hit?: { readonly at: number },
  ): void {
    const e = this.entries.get(memoryId);
    if (!e) return;
    const now = this.clock.now();
    this.entries.set(memoryId, {
      ...e,
      fitness,
      updatedAt: now,
      ...(hit !== undefined
        ? { hitCount: e.hitCount + 1, lastHitAt: hit.at, useCount: e.useCount + 1 }
        : {}),
    });
    /**
     * ★ 落状态变更事件。
     *
     *   ⚠️ 我第一版**没落** —— 理由是"演化引擎已经发了一条语义化的
     *      `fitness.updated`"。但那只覆盖**演化主循环**里的调用；
     *      `merge.ts` / 手动压低适应度 / 未来任何直接调用都会漏。
     *      验证 6 直接抓到：重放后 `fitness` 与真实值不一致。
     *
     *   教训：**state setter 不能假设调用方会替它落事件**。
     *   让 setter 自己保证"状态变化可重放"，是唯一可靠的边界。
     *   （代价是演化路径会有两条相邻事件 —— 一条语义、一条状态，
     *     这与 `memory.candidate/approved` + `memory.created` 是同一个模式。）
     */
    this.emitStateChanged(memoryId, 'fitness');
  }

  /**
   * 记录「这条记忆是由哪几条合并而来」（相似合并用，方案 § 8.3 第二层）。
   *
   * ⚠️ 被吸收的旧条目**归档而非删除**，且它们的 id 记在这里 ——
   *    所以合并始终可追溯、可回滚。与"淘汰 ≠ 删除"是同一立场。
   */
  setMergedFrom(memoryId: string, fromIds: readonly string[]): void {
    const e = this.entries.get(memoryId);
    if (!e) return;
    this.entries.set(memoryId, {
      ...e,
      mergedFrom: [...fromIds],
      updatedAt: this.clock.now(),
    });
    // ★ 合并来源也是一部分状态 —— 重放时要能恢复「这条是从哪几条合来的」
    this.emitStateChanged(memoryId, 'mergedFrom');
  }

  /**
   * 检查点回退后，把「回退之后才被依赖」的记忆标记为待复核。
   *
   * ⚠️ 全局硬约束**不降级**：它本来就该始终生效，不能因为回退变成候选。
   * 其余记忆切成 candidate，并落 `memory.candidate` 事件；重放能恢复这个状态。
   */
  markForReview(memoryId: string, note = '检查点回退后待复核'): boolean {
    const e = this.entries.get(memoryId);
    if (!e || e.memClass === 'global_constraint') return false;
    if (e.lifecycle === 'candidate') return true;

    const now = this.clock.now();
    const next: MemoryEntry = {
      ...e,
      lifecycle: 'candidate',
      updatedAt: now,
    };
    this.entries.set(memoryId, next);
    this.log.append({
      type: 'memory.candidate',
      actor: 'system',
      payload: {
        memoryId,
        snapshot: snapshotOf(next),
        note,
        decidedBy: 'system',
        audit: 'rollbackReview',
      },
      createdAt: now,
    });
    return true;
  }

  /** 写入生命周期与相关时间戳（演化引擎专用，同样不经过 canWrite）。 */
  setLifecycle(
    memoryId: string,
    lifecycle: MemoryLifecycle,
    meta: {
      readonly dormantSince?: number;
      readonly archivedAt?: number;
      readonly revivedCount?: number;
      readonly clearDormant?: boolean;
    } = {},
  ): void {
    const e = this.entries.get(memoryId);
    if (!e) return;

    const next: MemoryEntry = {
      ...e,
      lifecycle,
      updatedAt: this.clock.now(),
      ...(meta.revivedCount !== undefined ? { revivedCount: meta.revivedCount } : {}),
      ...(meta.dormantSince !== undefined ? { dormantSince: meta.dormantSince } : {}),
      ...(meta.archivedAt !== undefined ? { archivedAt: meta.archivedAt } : {}),
    };

    // 唤醒时清掉休眠标记（但归档时间保留，便于统计"曾经归档过"）
    const cleaned: MemoryEntry = meta.clearDormant
      ? (({ dormantSince: _drop, ...rest }) => rest as MemoryEntry)(next)
      : next;

    this.entries.set(memoryId, cleaned);
  }

  /** 写入效果跟踪（原则专用）。演化/审计路径调用，不经过 canWrite。 */
  setEffectiveness(memoryId: string, effectiveness: Effectiveness): void {
    const e = this.entries.get(memoryId);
    if (!e) return;
    this.entries.set(memoryId, { ...e, effectiveness, updatedAt: this.clock.now() });
    // ★ 落状态变更事件 —— 否则"这条原则用了 7 次"重放不出来
    this.emitStateChanged(memoryId, 'effectiveness');
  }

  /** 写入原则的结构化条件/动作（建档时给出，之后可修订）。 */
  setPrincipleDetail(memoryId: string, detail: PrincipleDetail): void {
    const e = this.entries.get(memoryId);
    if (!e) return;
    this.entries.set(memoryId, { ...e, principle: detail, updatedAt: this.clock.now() });
    // ★ 落状态变更事件 —— 否则原则的条件与动作重放不出来，
    //   而它们是**注入与违背检测的依据**（见 memory/principles.ts）
    this.emitStateChanged(memoryId, 'principle');
  }

  /**
   * 记录一次状态变更（供重放）。
   *
   * ⚠️ 这是本类中**唯一**为"纯状态写入"落事件的地方，用 `fitness.updated`
   *    这个已有的事件类型承载（它属于 evolution 族，语义是"这条记忆的状态变了"）。
   *
   *    为什么不新增事件类型：`memory.*` 族已经有 12 种，
   *    再加一个只为内部记账的类型会让事件族更难理解。
   *    `fitness.updated` 的 payload 本文就用 `field` 字段说明变的是哪一项。
   */
  private emitStateChanged(memoryId: string, field: string): void {
    const e = this.entries.get(memoryId);
    if (!e) return;
    this.log.append({
      type: 'fitness.updated',
      actor: 'system',
      payload: {
        memoryId,
        field,
        note: '状态字段更新（供重放）',
        snapshot: snapshotOf(e),
      },
      createdAt: this.clock.now(),
    });
  }

  /**
   * 记录一次冲突裁决结果（创新点 ③ 的效果验证）。
   *
   * 语义：
   *   · `won`  → succeeded +1（这条记忆参与裁决并胜出，说明它经得起考验）
   *   · `lost` → succeeded 不变，且**适应度小幅下降**
   *     （落败方只降权不删除 —— 方案 § 8.3 第二层"冲突消解"）
   *
   * ⚠️ **不改 applied** —— applied 的语义是"被注入给仆人"，
   *    裁决是另一条路径，混在一起会让那个数字失去意义。
   */
  recordVerdict(
    memoryId: string,
    outcome: 'won' | 'lost',
  ): { readonly ok: boolean; readonly fitnessBefore?: number; readonly fitnessAfter?: number } {
    const e = this.entries.get(memoryId);
    if (!e) return { ok: false };

    const now = this.clock.now();
    const eff = e.effectiveness ?? { applied: 0, succeeded: 0, lastAppliedAt: now };

    // 落败方降权而非删除 —— 渐变，不一刀切
    const penalty = outcome === 'lost' ? 0.05 : 0;
    const fitnessAfter = Math.max(0, e.fitness - penalty);

    this.entries.set(memoryId, {
      ...e,
      fitness: fitnessAfter,
      effectiveness: {
        applied: eff.applied,
        succeeded: eff.succeeded + (outcome === 'won' ? 1 : 0),
        lastAppliedAt: eff.lastAppliedAt,
      },
      updatedAt: now,
    });

    return { ok: true, fitnessBefore: e.fitness, fitnessAfter };
  }

  // ── 内部 ──

  /**
   * 解析归属。
   *
   * 领域记忆的归属**只看 domain**（管家代建档时也要显式指定），
   * 不从 actor 推断 —— 否则管家建的领域记忆归属就会含糊不清，
   * 而"每条记忆有 owner，审计时能说清是哪个角色写的"是清单要求。
   */
  private resolveOwner(_actor: MemoryActor, _input: CreateMemoryInput): MemoryOwner {
    return { kind: 'butler', userId: this.userId };
  }

  private nextId(): string {
    this.seq += 1;
    return `mem_${this.seq.toString(36)}_${this.clock.now().toString(36)}`;
  }
}
