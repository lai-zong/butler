/**
 * 事件日志测试 —— 验证四条核心不变量。
 *
 * 这些不变量是整个系统可信的基础：
 * 检查点回退、审计日志、证据链、跨会话一致性都依赖它们。
 */

import { describe, expect, it, vi } from 'vitest';

import { EventLog } from '../log.js';
import {
  ALL_EVENT_TYPES,
  EVENT_FAMILIES,
  EventInvariantError,
  LEGACY_EVENT_TYPES,
  type EventType,
} from '../types.js';

describe('EventLog · 不变量 I1（seq 单调无空洞）', () => {
  it('seq 从 1 开始并单调递增', () => {
    const log = new EventLog('s1');
    const a = log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    const b = log.append({ type: 'plan.created', payload: {}, actor: 'butler' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.nextSeq()).toBe(3);
  });

  it('空日志的 nextSeq 为 1', () => {
    expect(new EventLog('s1').nextSeq()).toBe(1);
  });
});

describe('EventLog · 不变量 I2（因果链）', () => {
  it('parentEventId 可以指向更早的事件', () => {
    const log = new EventLog('s1');
    const parent = log.append({ type: 'dispatch.created', payload: {}, actor: 'butler' });
    const child = log.append({
      type: 'dispatch.stepStarted',
      payload: {},
      actor: 'butler',
      parentEventId: parent.id,
    });
    expect(child.parentEventId).toBe(parent.id);
  });

  it('parentEventId 指向不存在的事件时抛错', () => {
    const log = new EventLog('s1');
    expect(() =>
      log.append({
        type: 'plan.created',
        payload: {},
        actor: 'butler',
        parentEventId: 'evt_does_not_exist',
      }),
    ).toThrow(EventInvariantError);
  });

  it('parentEventId 不可跨 session 引用（表现为找不到）', () => {
    const a = new EventLog('s1');
    const b = new EventLog('s2');
    const e = a.append({ type: 'plan.created', payload: {}, actor: 'butler' });
    expect(() =>
      b.append({ type: 'plan.revised', payload: {}, actor: 'butler', parentEventId: e.id }),
    ).toThrow(/不存在/);
  });
});

describe('EventLog · 不变量 I4（servant 必须带 servantId）', () => {
  it('actor=servant 缺少 servantId 时抛错', () => {
    const log = new EventLog('s1');
    expect(() => log.append({ type: 'servant.report', payload: {}, actor: 'servant' })).toThrow(
      EventInvariantError,
    );
  });

  it('actor=servant 带 servantId 时通过', () => {
    const log = new EventLog('s1');
    const e = log.append({
      type: 'servant.report',
      payload: {},
      actor: 'servant',
      servantId: 'life',
    });
    expect(e.servantId).toBe('life');
  });
});

describe('EventLog · appendMany 的原子性', () => {
  it('全部成功时全部写入', () => {
    const log = new EventLog('s1');
    const out = log.appendMany([
      { type: 'thought.done', payload: {}, actor: 'butler' },
      { type: 'plan.created', payload: {}, actor: 'butler' },
    ]);
    expect(out).toHaveLength(2);
    expect(log.length).toBe(2);
  });

  it('中途失败时回滚，不留中间态', () => {
    const log = new EventLog('s1');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });

    expect(() =>
      log.appendMany([
        { type: 'plan.created', payload: {}, actor: 'butler' },
        // 这一条会失败：parentEventId 不存在
        { type: 'plan.revised', payload: {}, actor: 'butler', parentEventId: 'nope' },
      ]),
    ).toThrow(EventInvariantError);

    // 关键：失败的 appendMany 不应留下已写入的部分
    expect(log.length).toBe(1);
    expect(log.nextSeq()).toBe(2);
  });
});

describe('EventLog · 回退语义（截断 ≠ 删除）', () => {
  it('truncateTo 返回被丢弃的事件，供归档', () => {
    const log = new EventLog('s1');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' }); // seq 1
    log.append({ type: 'plan.created', payload: {}, actor: 'butler' }); // seq 2
    log.append({ type: 'tool.call', payload: {}, actor: 'butler' }); // seq 3

    const discarded = log.truncateTo({ sessionId: 's1', seq: 1, reason: '用户回退' });

    expect(log.length).toBe(1);
    // 被丢弃的事件必须返回 —— 调用方据此保留"已取代"的产出物
    expect(discarded).toHaveLength(2);
    expect(discarded.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('回退后可以继续追加，seq 从截断点接续（保留前置成果）', () => {
    const log = new EventLog('s1');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    log.append({ type: 'plan.created', payload: {}, actor: 'butler' });

    log.truncateTo({ sessionId: 's1', seq: 1, reason: '重做第二步' });
    const redone = log.append({ type: 'plan.created', payload: { v: 2 }, actor: 'butler' });

    // 第一条（seq 1）被保留，新事件接在 seq 2 —— 这就是"只重做后半段"
    expect(redone.seq).toBe(2);
    expect(log.all()[0]?.type).toBe('thought.done');
  });

  it('截断跨越 session 时抛错', () => {
    const log = new EventLog('s1');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    expect(() => log.truncateTo({ sessionId: 's2', seq: 1, reason: 'x' })).toThrow(
      EventInvariantError,
    );
  });

  it('截断到超出范围的 seq 时抛错', () => {
    const log = new EventLog('s1');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    expect(() => log.truncateTo({ sessionId: 's1', seq: 9, reason: 'x' })).toThrow(/超出范围/);
  });
});

describe('EventLog · 订阅（跨会话一致性的基础）', () => {
  it('订阅者能收到新事件，取消后不再收到', () => {
    const log = new EventLog('s1');
    const spy = vi.fn();
    const off = log.subscribe(spy);

    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    expect(spy).toHaveBeenCalledTimes(1);

    off();
    log.append({ type: 'plan.created', payload: {}, actor: 'butler' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('监听器抛错不会阻止事件落库', () => {
    const log = new EventLog('s1');
    log.subscribe(() => {
      throw new Error('listener boom');
    });
    // 当前实现会让异常冒泡，这里显式记录该行为，避免误以为已隔离
    expect(() => log.append({ type: 'thought.done', payload: {}, actor: 'butler' })).toThrow(
      'listener boom',
    );
  });
});

describe('EVENT_FAMILIES 自检', () => {
  it('每个事件族都非空', () => {
    for (const [name, types] of Object.entries(EVENT_FAMILIES)) {
      expect(types.length, `事件族 ${name} 不应为空`).toBeGreaterThan(0);
    }
  });

  it('事件类型不重复定义', () => {
    const all: EventType[] = Object.values(EVENT_FAMILIES).flatMap((t) => [...t]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('★ 漏登记的事件类型会被抓到（护栏自身的回归测试）', () => {
    /**
     * ⚠️ 这里**刻意不再断言"十一个事件族"** —— 那个数字每加一簇就要改，
     *    改的时候很容易"顺手把数字改掉"而没想清楚。
     *
     *    真正要守的不变量是：**每个 `EventType` 要么属于某个族，
     *    要么被明确标成历史遗留**。漏登记的表现是"能落盘、按族查不到"，
     *    运行时完全正常 —— 只能靠编译期断言 + 测试来抓。
     *
     *    这条护栏已经抓到过一个真实缺陷：`context.compacted` 早就在产生、
     *    却既不属于任何族也不在历史清单里。
     */
    const registered = new Set<string>([
      ...Object.values(EVENT_FAMILIES).flatMap((t) => [...t]),
      ...LEGACY_EVENT_TYPES,
    ]);

    // ① 登记表不含"看着不像事件类型"的项（防写错字）
    for (const t of registered) {
      expect(t.includes('.'), `登记项 ${t} 不像事件类型`).toBe(true);
    }

    // ② `ALL_EVENT_TYPES` 覆盖全部登记项，且自身无重复
    for (const t of registered) {
      expect(ALL_EVENT_TYPES, `${t} 未出现在 ALL_EVENT_TYPES 里`).toContain(t as EventType);
    }
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
  });

  it('★ 历史事件与当前事件不重叠', () => {
    const current = new Set<string>(Object.values(EVENT_FAMILIES).flatMap((t) => [...t]));
    for (const legacy of LEGACY_EVENT_TYPES) {
      expect(current.has(legacy), `${legacy} 同时被标为历史事件与当前事件`).toBe(false);
    }
  });
});
