/**
 * 敏感域自主授权（2026-11-11）
 *
 * ★ 要证明的行为：
 *   ① 无关的对话**不会**让敏感域记忆变得可见（隔离仍然有效）；
 *   ② 相关的对话会由管家**自己**签发一条有时限的授权，随后可见；
 *   ③ 授权按会话隔离，不会泄漏给别的会话；
 *   ④ 每次签发都落事件（可审计），且授权能随快照跨重启存活；
 *   ⑤ 归档/遗忘的敏感记忆不参与。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock, type ClockPort } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import { unlockSensitiveForTurn } from '../autonomousAccess.js';
import { hydrateStore, replayMemory } from '../replay.js';

const T0 = 1_760_000_000_000;
const USER = 'u_auto';
const SESSION = 's_auto';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog(SESSION);
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  store.create(butler, {
    id: 'mem_sens_scare',
    memClass: 'sensitive',
    kind: 'fact',
    content: '心理咨询记录：对公开演讲有强烈焦虑',
    confidence: 0.9,
    evidence: ['e1'],
    lifecycle: 'active',
  });
  store.create(butler, {
    id: 'mem_plain',
    memClass: 'global_shared',
    kind: 'fact',
    content: '用户喜欢喝无糖豆浆',
    confidence: 0.9,
    evidence: ['e2'],
    lifecycle: 'active',
  });
  return { log, clock, store };
}

const visibleIds = (store: MemoryStore, sessionId = SESSION): readonly string[] =>
  store
    .visibleTo({ kind: 'butler', userId: USER, taskId: sessionId })
    .map((e) => e.id)
    .sort();

describe('敏感域自主授权', () => {
  it('无关对话不放开（隔离仍然有效）', () => {
    const { log, clock, store } = setup();
    const outcome = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '今晚吃什么好，推荐几个菜',
    });

    expect(outcome.granted).toEqual([]);
    expect(visibleIds(store)).toEqual(['mem_plain']);
    expect(log.byType('grant.approved')).toHaveLength(0);
  });

  it('相关对话由管家自己签发授权，随后可见', () => {
    const { log, clock, store } = setup();
    // 用语义分模拟"嵌入模型判断相关"——真实路径由 service 计算后传入
    const outcome = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '我下周要上台演讲，紧张得睡不着',
      scores: new Map([['mem_sens_scare', 0.82]]),
    });

    expect(outcome.granted.map((g) => g.memoryId)).toEqual(['mem_sens_scare']);
    expect(visibleIds(store)).toEqual(['mem_plain', 'mem_sens_scare']);

    // 授权是 butler 自己签的，不是用户点的
    const approved = log.byType('grant.approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]?.actor).toBe('butler');
    expect(approved[0]?.payload).toMatchObject({ memoryId: 'mem_sens_scare', taskId: SESSION });
  });

  it('授权按会话隔离：别的会话仍然看不到', () => {
    const { clock, store } = setup();
    unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '演讲焦虑',
      scores: new Map([['mem_sens_scare', 0.9]]),
    });

    expect(visibleIds(store)).toContain('mem_sens_scare');
    expect(visibleIds(store, 's_other')).not.toContain('mem_sens_scare');
  });

  it('同一会话重复调用不会重复签发', () => {
    const { log, clock, store } = setup();
    const args = {
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '演讲焦虑',
      scores: new Map([['mem_sens_scare', 0.9]]),
    };
    unlockSensitiveForTurn(args);
    const second = unlockSensitiveForTurn(args);

    expect(second.granted).toEqual([]);
    expect(second.skipped.some((s) => s.reason === 'already_granted')).toBe(true);
    expect(log.byType('grant.approved')).toHaveLength(1);
  });

  it('每轮有上限，不会一次性全放开', () => {
    const { clock, store } = setup();
    for (let i = 0; i < 5; i++) {
      store.create(butler, {
        id: `mem_extra_${i}`,
        memClass: 'sensitive',
        kind: 'fact',
        content: `敏感记录 ${i}`,
        confidence: 0.8,
        evidence: [],
        lifecycle: 'active',
      });
    }
    const scores = new Map<string, number>([['mem_sens_scare', 0.99]]);
    for (let i = 0; i < 5; i++) scores.set(`mem_extra_${i}`, 0.6 + i * 0.01);

    const outcome = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '演讲焦虑',
      scores,
      policy: { maxPerTurn: 2 },
    });

    expect(outcome.granted).toHaveLength(2);
    expect(outcome.skipped.some((s) => s.reason === 'over_turn_limit')).toBe(true);
  });

  it('没有语义分时退回字面门槛：近乎同句才放开', () => {
    const { clock, store } = setup();
    const same = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '心理咨询记录对公开演讲有强烈焦虑',
    });
    expect(same.granted.map((g) => g.memoryId)).toEqual(['mem_sens_scare']);

    const unrelated = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: 's_other',
      query: '帮我写一段 Python 排序',
    });
    expect(unrelated.granted).toEqual([]);
  });

  it('归档的敏感记忆不放开', () => {
    const { clock, store } = setup();
    store.archive('mem_sens_scare', '用户删除');

    const outcome = unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '心理咨询记录对公开演讲有强烈焦虑',
      scores: new Map([['mem_sens_scare', 0.99]]),
    });

    expect(outcome.granted).toEqual([]);
  });

  it('授权随快照跨重启存活（与 B 批的快照修复联动）', () => {
    const { log, clock, store } = setup();
    unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '演讲焦虑',
      scores: new Map([['mem_sens_scare', 0.9]]),
    });
    // 触发一次状态事件，让 grants 进入快照
    store.archive('mem_plain', '触发快照');

    const result = replayMemory(log.all());
    const fresh = new MemoryStore(new EventLog('s_restart'), clock, USER);
    hydrateStore({ store: fresh, result });

    const entry = fresh.get('mem_sens_scare');
    expect(entry?.grants).toHaveLength(1);
    expect(entry?.grants?.[0]?.taskId).toBe(SESSION);
  });
});

describe('授权被实际使用时有据可查', () => {
  it('noteGrantUsed 只对有效授权记事件', () => {
    const { log, clock, store } = setup();
    // 没有授权时不记
    expect(store.noteGrantUsed('mem_sens_scare', SESSION, '测试')).toBe(false);
    expect(log.byType('grant.used')).toHaveLength(0);

    unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '演讲焦虑',
      scores: new Map([['mem_sens_scare', 0.9]]),
    });

    expect(store.noteGrantUsed('mem_sens_scare', SESSION, '本轮召回并注入上下文')).toBe(true);
    expect(log.byType('grant.used')).toHaveLength(1);
    expect(log.byType('grant.used')[0]?.payload).toMatchObject({
      memoryId: 'mem_sens_scare',
      taskId: SESSION,
    });
  });

  it('TTL 到期后授权失效：不可读，也不记"使用"', () => {
    // 可变时钟：验证"按任务失效"的另一半（任务没结束但授权到期）
    class MutableClock implements ClockPort {
      constructor(public t: number) {}
      now(): number {
        return this.t;
      }
    }
    const clock = new MutableClock(T0);
    const log = new EventLog(SESSION);
    const store = new MemoryStore(log, clock, USER);
    store.create(butler, {
      id: 'mem_ttl',
      memClass: 'sensitive',
      kind: 'fact',
      content: '敏感记录：信用卡额度',
      confidence: 0.9,
      evidence: [],
      lifecycle: 'active',
    });

    unlockSensitiveForTurn({
      store,
      clock,
      userId: USER,
      sessionId: SESSION,
      query: '我的信用卡额度是多少',
      scores: new Map([['mem_ttl', 0.8]]),
      policy: { ttlMs: 1_000 },
    });

    const actor = { kind: 'butler', userId: USER, taskId: SESSION } as const;
    expect(store.canRead(actor, store.get('mem_ttl')!)).toBeNull();
    expect(store.noteGrantUsed('mem_ttl', SESSION, 'x')).toBe(true);

    clock.t += 2_000; // 超过 1 秒 TTL
    expect(store.canRead(actor, store.get('mem_ttl')!)).toBe('sensitive_no_grant');
    expect(store.noteGrantUsed('mem_ttl', SESSION, 'x')).toBe(false);
  });
});
