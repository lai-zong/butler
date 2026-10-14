/**
 * 系统时钟
 *
 * 真实实现放在 adapters/，因为 core 层禁止直接使用 Date.now()（ADR 0004）。
 */

import type { ClockPort } from '../../core/ports/clock.js';

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
