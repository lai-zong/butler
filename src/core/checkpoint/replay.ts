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

/**
 * 从事件流重建状态。
 *
 * 这是"事件是唯一真相源"的直接体现 ——
 * 检查点不存这些内容，全部靠这个函数算出来。
 */
export function replay(events: readonly SessionEvent[]): ReplayResult {
  const completed = new Set<string>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  const artifacts = new Set<string>();
  const memories = new Set<string>();

  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    const stepId = typeof p?.['stepId'] === 'string' ? p['stepId'] : undefined;

    switch (e.type) {
      case 'dispatch.created': {
        const steps = p?.['steps'];
        if (Array.isArray(steps)) {
          for (const s of steps) {
            const id = (s as { stepId?: unknown }).stepId;
            if (typeof id === 'string') pending.add(id);
          }
        }
        break;
      }
      case 'dispatch.stepDone':
        if (stepId) {
          pending.delete(stepId);
          failed.delete(stepId);
          completed.add(stepId);
        }
        break;
      case 'dispatch.stepFailed':
        if (stepId) {
          pending.delete(stepId);
          failed.add(stepId);
        }
        break;

      case 'artifact.created':
      case 'artifact.revised': {
        const id = p?.['artifactId'];
        if (typeof id === 'string') artifacts.add(id);
        break;
      }
      case 'artifact.superseded': {
        const id = p?.['artifactId'];
        if (typeof id === 'string') artifacts.delete(id);
        break;
      }

      case 'memory.candidate':
      case 'memory.approved':
      case 'memory.revised':
      case 'memory.recalled': {
        const id = p?.['memoryId'];
        if (typeof id === 'string') memories.add(id);
        break;
      }
      case 'memory.rejected':
      case 'memory.archived':
      case 'intervention.forgotten': {
        const id = p?.['memoryId'];
        if (typeof id === 'string') memories.delete(id);
        break;
      }
      default:
        break;
    }
  }

  return {
    state: {
      completedSteps: [...completed].sort(),
      pendingSteps: [...pending].sort(),
      failedSteps: [...failed].sort(),
      artifactIds: [...artifacts].sort(),
      memoryIds: [...memories].sort(),
    },
    stateHash: stateHashOf(events),
    eventCount: events.length,
  };
}
