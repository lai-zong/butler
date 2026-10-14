/**
 * 端口 · 时钟与随机数
 *
 * 设计依据：ADR 0004
 *
 * 这两个看起来是小事，但它们是**产品正确性的前提**：
 * 方案 § 8 要求"同一段事件流重放两次必须得到完全相同的状态"。
 * 一旦核心层里直接写 Date.now() 或 Math.random()，重放就不确定，
 * 而"回退结果可信"是本项目的核心卖点。
 *
 * 因此核心层**禁止**直接调用它们，一律走这两个端口。
 */

export interface ClockPort {
  /** 当前时间（毫秒时间戳） */
  now(): number;
}

export interface RandomPort {
  /** [0, 1) 区间的浮点数 */
  next(): number;
  /** 从数组中随机取一个元素；数组为空时返回 undefined */
  pick<T>(items: readonly T[]): T | undefined;
}

// ═══════════════════════════════════════════════════════════
// 测试与重放用实现（放在 core 里，因为它们是纯逻辑）
// ═══════════════════════════════════════════════════════════

/** 固定时钟：始终返回同一时间。重放时使用。 */
export class FixedClock implements ClockPort {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  /** 显式推进 —— 让时间变化成为可见的、可审计的动作 */
  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * 确定性随机数（mulberry32）。
 *
 * 用途：需要一点随机性（如探索性召回，方案 § 8.5）但又要可复现的场景。
 * 同一个种子必然产出同一串数。
 */
export class SeededRandom implements RandomPort {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    const idx = Math.floor(this.next() * items.length);
    return items[idx];
  }
}
