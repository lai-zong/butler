/**
 * 状态哈希与确定性重放
 *
 * 设计依据：方案 § 5.2「可复现信息」、ADR 0004（确定性要求）
 *
 * ★ 为什么需要状态哈希：
 *   本项目的核心卖点是"回退结果可信"。
 *   如果同一段事件流重放两次得到**不同**的状态，用户回退两次结果不一样，
 *   整个可信叙事当场崩塌。
 *
 *   所以每次重放后算一个哈希，与检查点记录的值比对；
 *   不一致就报警（说明核心层混进了不确定因素：
 *   Date.now()、Math.random()、依赖迭代顺序的 Map 遍历……）。
 */

import type { SessionEvent } from '../events/types.js';

/**
 * 稳定字符串化 —— 键排序，保证同一对象永远产出同一串。
 *
 * 不能用 `JSON.stringify` 直接上：对象键顺序不同会产出不同结果，
 * 而 JS 对象键顺序在重放路径里**不保证稳定**。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    // 统一浮点表示，避免 0.1+0.2 这类差异
    return Number.isFinite(value) ? value.toFixed(6) : 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return 'null';
}

/**
 * FNV-1a 32 位哈希。
 *
 * 选它的理由：实现简单、无依赖、**确定性**，够用于一致性校验。
 * 这不是密码学哈希 —— 用途只是"两次重放是否一致"，不需要抗碰撞。
 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 乘 16777619，用移位避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 计算事件流的状态哈希。
 *
 * ⚠️ 刻意**只纳入会影响状态的部分**，排除：
 *    · `createdAt` —— 时间戳在重放时是读出来的，天然不同
 *    · `usage`     —— 用量统计不影响业务状态
 *
 * 纳入的是：seq、type、actor、payload（规范化后）、因果链。
 * 一旦有人往核心逻辑里塞了 Date.now()，payload 就会带上时间，
 * 哈希随即不一致 —— 这正是我们想要它抓的东西。
 */
export function stateHashOf(events: readonly SessionEvent[]): string {
  const normalized = events.map((e) => ({
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    servantId: e.servantId ?? null,
    parentEventId: e.parentEventId ?? null,
    payload: canonicalPayload(e.payload),
  }));
  return hashString(stableStringify(normalized));
}

/**
 * 规范化 payload —— 剥掉不影响业务状态的字段。
 *
 * 目前剥掉：usage、promptVersions、以及嵌套的 usage。
 * 这些都是"元数据"，不构成业务状态。
 */
export function canonicalPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(canonicalPayload);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k === 'usage' || k === 'promptVersions' || k === 'promptVersion') continue;
    out[k] = canonicalPayload(v);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 重放
// ═══════════════════════════════════════════════════════════

export interface ReplayResult {
  /** 重放后的状态 */
  readonly state: {
    readonly completedSteps: readonly string[];
    readonly pendingSteps: readonly string[];
    readonly failedSteps: readonly string[];
    readonly artifactIds: readonly string[];
    readonly memoryIds: readonly string[];
  };
  readonly stateHash: string;
  readonly eventCount: number;
}

/** 重放后的状态形状（供累加器与调用方共用同一个类型）。 */
export type ReplayState = ReplayResult['state'];

/**
 * 可增量喂事件的累加器。
 *
 * ★ 为什么需要它（实测）：
 *   检查点重建原来是"每个检查点重放一遍 1..seq" —— O(n²)。
 *   本机 4,144 条事件、507 个检查点，启动要 **24 秒**。
 *   而每次 `replay()` 还会对整段事件做一次哈希（纯字符串化），
 *   在重建路径上完全用不到。
 *
 *   改成"一次前向扫描 + 每到检查点取一次当前状态"后，
 *   单点快照成本从 O(n) 降到 O(1)。
 *
 * ⚠️ 语义必须与 `replay()` 完全一致：`state()` 返回的就是
 *    "处理到当前事件为止"的状态（含当前事件）。
 */
export class ReplayAccumulator {
  private readonly completed = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly artifacts = new Set<string>();
  private readonly memories = new Set<string>();

  apply(event: SessionEvent): void {
    const p = event.payload as Record<string, unknown> | null;
    const stepId = typeof p?.['stepId'] === 'string' ? p['stepId'] : undefined;

    switch (event.type) {
      // ═══════════════════════════════════════════════════════
      // ⚠️ 历史分支（多执行者时代）—— 当前代码**不产生**这些事件
      //
      //   ★ 保留理由：**重放旧日志时必须按当时的语义重建步骤状态**。
      //     删了这些分支，历史会话的 `completedSteps` 会突然变空，
      //     「回退到某一步」就查不到它之前完成了什么。
      //
      //   ⚠️ 读到这里请注意：**它们的为空不是 bug** ——
      //      当前架构只有一次执行（`butler.executed`），
      //      没有「步骤」这个概念，所以 `completedSteps` 对新会话本就是空的。
      //      （"每轮一个单元"的粒度尚未引入，见 docs/refactor-status.md §7.3）
      // ═══════════════════════════════════════════════════════
      case 'dispatch.created': {
        const steps = p?.['steps'];
        if (Array.isArray(steps)) {
          for (const s of steps) {
            const id = (s as { stepId?: unknown }).stepId;
            if (typeof id === 'string') this.pending.add(id);
          }
        }
        break;
      }
      case 'dispatch.stepDone':
        if (stepId) {
          this.pending.delete(stepId);
          this.failed.delete(stepId);
          this.completed.add(stepId);
        }
        break;
      case 'dispatch.stepFailed':
        if (stepId) {
          this.pending.delete(stepId);
          this.failed.add(stepId);
        }
        break;

      case 'artifact.created':
      case 'artifact.revised': {
        const id = p?.['artifactId'];
        if (typeof id === 'string') this.artifacts.add(id);
        break;
      }
      case 'artifact.superseded': {
        const id = p?.['artifactId'];
        if (typeof id === 'string') this.artifacts.delete(id);
        break;
      }

      // ⚠️ 检查点只引用**会话事件显式引用过**的记忆。
      //
      //    踩过的坑：记忆事件与会话事件共用同一个 EventLog，
      //    如果按"凡是出现 memoryId 的事件都算依赖"来收集，
      //    就会把**记忆库里后来新增的、跟本次会话无关的记忆**也算成依赖 ——
      //    结果是删掉任意一条记忆，全部检查点集体失效。
      //    实测：本该只失效 1 个，实际失效了 8 个。
      //
      //    正确的依赖来源只有两处：
      //      · `constraint.injected` —— 管家注入给某步骤的约束（真正被依赖）
      //      · `servant.report.memoryRefs` —— 仆人声明用到了哪些记忆
      //    `memory.recalled` 是"读了但没依赖"，`memory.candidate` 是"产生了"
      //    （产出物，不是依赖），都不该让检查点因它被删而失效。

      case 'constraint.injected': {
        const id = p?.['memoryId'];
        if (typeof id === 'string') this.memories.add(id);
        break;
      }

      /**
       * ⚠️ 历史分支：`servant.report.payload.memoryRefs`。
       *
       * 当前架构的记忆依赖走 `constraint.injected`（上面那条），
       * 所以本分支在**新日志上不可达**。
       *
       * ★ 保留理由：回退旧日志时要按当时的语义重建"用了哪些记忆"。
       */
      case 'servant.report': {
        const refs = p?.['memoryRefs'];
        if (Array.isArray(refs)) {
          for (const r of refs) if (typeof r === 'string') this.memories.add(r);
        }
        break;
      }

      default:
        break;
    }
  }

  state(): ReplayResult['state'] {
    return {
      completedSteps: [...this.completed].sort(),
      pendingSteps: [...this.pending].sort(),
      failedSteps: [...this.failed].sort(),
      artifactIds: [...this.artifacts].sort(),
      memoryIds: [...this.memories].sort(),
    };
  }
}

/**
 * 从事件流重建状态。
 *
 * 这是"事件是唯一真相源"的直接体现 ——
 * 检查点不存这些内容，全部靠这个函数算出来。
 */
export function replay(events: readonly SessionEvent[]): ReplayResult {
  const acc = new ReplayAccumulator();
  for (const e of events) acc.apply(e);

  return {
    state: acc.state(),
    stateHash: stateHashOf(events),
    eventCount: events.length,
  };
}
