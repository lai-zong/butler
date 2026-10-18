/**
 * 事件可重放护栏（v8 批次A 新增）。
 *
 * ★★ 这个文件守的是一条**已经踩过的坑**：
 *
 *   新增一种事件时，如果重放逻辑里有对 `payload` 字段的假定
 *   （例如"`payload.stepId` 一定存在"），而新事件没给，
 *   重放就会抛错 —— 表现是**整个会话打不开**，而不是"少显示一点东西"。
 *
 *   所以这里遍历**全部** `EventType`，用最小可用 payload 逐个重放，
 *   断言不抛错。以后再加事件，这条测试自动覆盖它（无需改测试）。
 *
 * ⚠️ 它与 `types.ts` 里的编译期断言（`UnregisteredEventType`）是互补的两道：
 *    · 编译期：新增事件**必须登记到某个族**
 *    · 运行时：新增事件**不能让重放崩**
 */

import { describe, expect, it } from 'vitest';

import { replay } from '../../checkpoint/replay.js';
import { ALL_EVENT_TYPES, EVENT_FAMILIES, LEGACY_EVENT_TYPES, type EventType } from '../types.js';
import type { SessionEvent } from '../types.js';

const SESSION = 'sess_test';

/**
 * 造一条最小事件。
 *
 * ⚠️ 刻意给**空 payload**：如果重放代码假定了某个字段存在，这里就会炸 ——
 *    而那正是我们要抓的。真实写入路径有各自的 Zod 校验，不靠重放兜底。
 */
function minimalEvent(type: EventType, seq: number): SessionEvent {
  return {
    sessionId: SESSION,
    seq,
    type,
    actor: 'system',
    payload: {},
    createdAt: 1_700_000_000_000 + seq,
  } as SessionEvent;
}

describe('★ 事件可重放护栏', () => {
  it('全部事件类型（含历史）逐个重放都不抛错', () => {
    expect(ALL_EVENT_TYPES.length).toBeGreaterThan(80);

    let seq = 1;
    for (const type of ALL_EVENT_TYPES) {
      const event = minimalEvent(type, seq++);
      expect(
        () => replay([event]),
        `事件类型 ${type} 重放时抛错 —— 重放逻辑假定了 payload 字段`,
      ).not.toThrow();
    }
  });

  it('全部事件类型混在一条流里重放也不抛错', () => {
    const events = ALL_EVENT_TYPES.map((type, i) => minimalEvent(type, i + 1));
    expect(() => replay(events)).not.toThrow();
  });

  it('★ 空 payload 的事件重放后状态保持为空（不制造幽灵步骤/产出物）', () => {
    const events = ALL_EVENT_TYPES.map((type, i) => minimalEvent(type, i + 1));
    const { state } = replay(events);

    // 没有真实 payload 时，任何"从 payload 派生 id"的逻辑都该跳过而不是编造
    expect(state.artifactIds).toEqual([]);
    expect(state.memoryIds).toEqual([]);
    expect(state.pendingSteps).toEqual([]);
    expect(state.failedSteps).toEqual([]);
    // completedSteps 只由历史 dispatch.* 派生，空 payload 下也应为空
    expect(state.completedSteps).toEqual([]);
  });

  it('重放是纯函数：同一条流重放两次结果一致', () => {
    const events = ALL_EVENT_TYPES.map((type, i) => minimalEvent(type, i + 1));
    expect(JSON.stringify(replay(events).state)).toBe(JSON.stringify(replay(events).state));
  });

  it('事件族与历史清单合起来覆盖全部事件类型（与编译期断言互为备份）', () => {
    const registered = new Set<string>([
      ...Object.values(EVENT_FAMILIES).flatMap((t) => [...t]),
      ...LEGACY_EVENT_TYPES,
    ]);
    for (const type of ALL_EVENT_TYPES) {
      expect(registered.has(type), `${type} 既不在任何事件族，也不在历史清单`).toBe(true);
    }
  });
});
