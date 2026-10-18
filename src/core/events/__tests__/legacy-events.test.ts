/**
 * 事件词汇表 —— 锁住「历史事件与当前词汇分离」这件事（v8 · 批次F）
 *
 * ★★ 这个文件防的是**认知回归**：
 *
 *   一个读者（包括未来的我）翻到 `EventType` 里看到 `servant.report` /
 *   `dispatch.stepStarted`，很容易断定"系统里有多执行者、管家会派活给仆人"。
 *   **而那是 v8 之前的事** —— 现在代码里没有 `runServant`、没有派发。
 *
 *   ⚠️ 这类误解我**真的犯过**：读代码时把旧词汇当成当前架构，
 *      于是后续判断建立在错误的模型上。
 *
 *   ✅ 这个测试确保：
 *      ① 所有多执行者时代的事件类型都在 `LEGACY_EVENT_TYPES` 里（有清单可查）
 *      ② `isLegacyEventType` 判定准确
 *      ③ 当前架构的核心事件**不在**历史清单里（别把现在的也标成历史）
 */

import { describe, expect, it } from 'vitest';

import {
  LEGACY_EVENT_TYPES,
  isLegacyEventType,
  type EventType,
} from '../types.js';

describe('★ 历史事件清单（多执行者时代的残留）', () => {
  it('所有 servant.* 事件都在历史清单里', () => {
    // ⚠️ 这里**硬编码**清单而不是从 EVENT_FAMILIES 推导：
    //    推导会"自动通过"（我把新类型加进族里、它就自动算历史），
    //    硬编码才能在**新增 servant 事件**时报警 —— 那正是要拦的事。
    const servantEvents: EventType[] = [
      'servant.report',
      'servant.blocked',
      'servant.needsDecision',
    ];
    for (const t of servantEvents) {
      expect(LEGACY_EVENT_TYPES).toContain(t);
    }
  });

  it('所有 dispatch.* 事件都在历史清单里', () => {
    const dispatchEvents: EventType[] = [
      'dispatch.created',
      'dispatch.stepStarted',
      'dispatch.stepDone',
      'dispatch.stepFailed',
    ];
    for (const t of dispatchEvents) {
      expect(LEGACY_EVENT_TYPES).toContain(t);
    }
  });

  it('isLegacyEventType 判定准确', () => {
    expect(isLegacyEventType('servant.report')).toBe(true);
    expect(isLegacyEventType('servant.blocked')).toBe(true);
    expect(isLegacyEventType('dispatch.stepStarted')).toBe(true);
    expect(isLegacyEventType('route.decided')).toBe(true);

    // 当前架构的事件**不能**被当成历史
    expect(isLegacyEventType('contract.written')).toBe(false);
    expect(isLegacyEventType('butler.executed')).toBe(false);
    expect(isLegacyEventType('supervisor.observe')).toBe(false);
    expect(isLegacyEventType('route.assumed')).toBe(false);
  });

  it('★ 当前架构的"主干三件事"都不是历史事件', () => {
    // 承诺 → 执行 → 复核。这三条串起来就是 v8 的完整链路。
    const backbone: EventType[] = [
      'contract.written',
      'butler.executed',
      'supervisor.observe',
    ];
    for (const t of backbone) {
      expect(isLegacyEventType(t)).toBe(false);
    }
  });

  it('历史清单里没有重复项', () => {
    expect(new Set(LEGACY_EVENT_TYPES).size).toBe(LEGACY_EVENT_TYPES.length);
  });
});
