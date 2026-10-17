/**
 * 原则注入与违背检测测试
 *
 * ★ 补的是一个真闭环缺口：
 *   反思能产出原则、用户能审核生效，但**执行时从不注入它们** ——
 *   `principle.applied` 事件从来没被发出过。等于"学了但不用"。
 *
 * 本文件锁住四件事：
 *   ① 按条件相关性挑选原则（不相关的不注入）
 *   ② 效果好的优先（优胜劣汰），但效果差的**不排除**（仍有翻身机会）
 *   ③ 注入即记 applied +1（数字必须真实）
 *   ④ 违背检测：未命中报"疑似违背"，交由监督层复核
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import {
  MAX_PRINCIPLES_PER_TASK,
  checkPrinciples,
  principleStats,
  recordEffect,
  recordInjection,
  recordViolation,
  selectPrinciples,
} from '../principles.js';
import type { PrincipleDetail } from '../types.js';

const T0 = 1_760_000_000_000;
const USER = 'u_pr';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_pr');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

/** 建一条已生效的原则。 */
function addPrinciple(
  store: MemoryStore,
  args: {
    id: string;
    content: string;
    condition: string;
    action: string;
    domain?: 'life' | 'health' | 'work' | 'code' | 'study';
    applied?: number;
    succeeded?: number;
  },
): string {
  const r = store.create(butler, {
    id: args.id,
    memClass: args.domain !== undefined ? 'domain' : 'global_shared',
    kind: 'principle',
    content: args.content,
    confidence: 0.8,
    evidence: ['evt_1'],
    lifecycle: 'active',
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
  });
  if (!r.ok) throw new Error(`建档失败：${r.reason}`);

  const detail: PrincipleDetail = { condition: args.condition, action: args.action };
  store.setPrincipleDetail(args.id, detail);

  if (args.applied !== undefined) {
    store.setEffectiveness(args.id, {
      applied: args.applied,
      succeeded: args.succeeded ?? 0,
      lastAppliedAt: T0,
    });
  }
  return args.id;
}

// ═══════════════════════════════════════════════════════════
// ① 按条件挑选
// ═══════════════════════════════════════════════════════════

describe('① 原则挑选 · 按条件相关性', () => {
  it('条件与任务相关的被选中', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '推荐餐厅前先确认同行人忌口',
      condition: '推荐餐厅或安排聚餐时',
      action: '先问清同行人的饮食禁忌再给方案',
    });

    const picked = selectPrinciples({ store, task: '周末请朋友吃饭，推荐几家餐厅' });
    expect(picked).toHaveLength(1);
    expect(picked[0]?.principle.id).toBe('p1');
  });

  it('★ 条件不相关的被排除', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '提交代码前先跑测试',
      condition: '修改代码之后',
      action: '运行测试套件确认无回归',
    });

    const picked = selectPrinciples({ store, task: '帮我安排一次家宴' });
    expect(picked).toHaveLength(0);
  });

  it('未生效（候选）的原则不参与注入', () => {
    const { store } = setup();
    const r = store.create(butler, {
      id: 'cand',
      memClass: 'global_shared',
      kind: 'principle',
      content: '推荐餐厅前确认忌口',
      confidence: 0.5,
      evidence: [],
      lifecycle: 'candidate',
    });
    expect(r.ok).toBe(true);
    store.setPrincipleDetail('cand', { condition: '推荐餐厅时', action: '确认忌口' });

    expect(selectPrinciples({ store, task: '推荐餐厅' })).toHaveLength(0);
  });

  it('非 principle 类型的记忆不被当作原则', () => {
    const { store } = setup();
    store.create(butler, {
      id: 'pref',
      memClass: 'global_shared',
      kind: 'preference',
      content: '偏好清淡口味的餐厅',
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
    });
    expect(selectPrinciples({ store, task: '推荐清淡口味的餐厅' })).toHaveLength(0);
  });

  it('★ 条数有上限（避免淹没任务本身）', () => {
    const { store } = setup();
    for (let i = 0; i < 8; i++) {
      addPrinciple(store, {
        id: `p${i}`,
        content: `推荐餐厅的第 ${i} 条原则`,
        condition: '推荐餐厅时',
        action: '先确认同行人忌口',
      });
    }
    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    expect(picked.length).toBeLessThanOrEqual(MAX_PRINCIPLES_PER_TASK);
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 优胜劣汰（但渐变，不一刀切）
// ═══════════════════════════════════════════════════════════

describe('② ★ 效果好的优先，效果差的不排除', () => {
  it('效果好的排在前面', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'good',
      content: '推荐餐厅前确认忌口',
      condition: '推荐餐厅时',
      action: '确认同行人忌口',
      applied: 10,
      succeeded: 10,
    });
    addPrinciple(store, {
      id: 'bad',
      content: '推荐餐厅前看评分',
      condition: '推荐餐厅时',
      action: '看评分',
      applied: 10,
      succeeded: 1,
    });

    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    expect(picked[0]?.principle.id).toBe('good');
  });

  it('★ 效果差的原则**仍然会被注入**（否则永远无法翻身）', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'bad',
      content: '推荐餐厅前看评分',
      condition: '推荐餐厅时',
      action: '看评分',
      applied: 10,
      succeeded: 1,
    });

    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    expect(picked.map((p) => p.principle.id)).toContain('bad');
  });

  it('新原则（无应用记录）不被压低', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'fresh',
      content: '推荐餐厅前确认忌口',
      condition: '推荐餐厅时',
      action: '确认忌口',
    });
    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    expect(picked).toHaveLength(1);
    expect(picked[0]?.why).toContain('尚无应用记录');
  });

  it('why 里说明效果差的仍保留机会', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'bad2',
      content: '推荐餐厅前看评分',
      condition: '推荐餐厅时',
      action: '看评分',
      applied: 10,
      succeeded: 1,
    });
    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    expect(picked[0]?.why).toContain('仍保留机会');
  });

  it('本领域的领域原则获得加权', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'domainp',
      content: '推荐餐厅前确认忌口',
      condition: '推荐餐厅时',
      action: '确认忌口',
      domain: 'life',
    });
    const withServant = selectPrinciples({ store, task: '推荐餐厅', servant: 'life' });
    const without = selectPrinciples({ store, task: '推荐餐厅' });
    expect(withServant[0]!.relevance).toBeGreaterThan(without[0]!.relevance);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 注入即计（applied 必须真实）
// ═══════════════════════════════════════════════════════════

describe('③ ★ 注入才计 applied', () => {
  it('注入后 applied +1 并落 principle.applied 事件', () => {
    const { store, log, clock } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '推荐餐厅前确认忌口',
      condition: '推荐餐厅时',
      action: '确认忌口',
    });

    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    recordInjection({ log, store, clock, taskId: 's1', candidates: picked });

    expect(store.get('p1')?.effectiveness?.applied).toBe(1);
    const ev = log.byType('principle.applied');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({
      memoryId: 'p1',
      taskId: 's1',
      appliedTotal: 1,
    });
  });

  it('多次注入累计', () => {
    const { store, log, clock } = setup();
    addPrinciple(store, { id: 'p1', content: '餐厅忌口', condition: '推荐餐厅', action: '确认忌口' });
    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    recordInjection({ log, store, clock, taskId: 's1', candidates: picked });
    recordInjection({ log, store, clock, taskId: 's2', candidates: picked });
    expect(store.get('p1')?.effectiveness?.applied).toBe(2);
    expect(log.byType('principle.applied')).toHaveLength(2);
  });

  it('事件里记录条件与动作（便于事后追查"为什么注入它"）', () => {
    const { store, log, clock } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '餐厅忌口',
      condition: '推荐餐厅或安排聚餐时',
      action: '先确认同行人忌口',
    });
    const picked = selectPrinciples({ store, task: '推荐餐厅' });
    recordInjection({ log, store, clock, taskId: 's1', candidates: picked });

    const payload = log.byType('principle.applied')[0]?.payload as Record<string, unknown>;
    expect(payload['condition']).toContain('推荐餐厅');
    expect(payload['action']).toContain('确认');
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 违背检测
// ═══════════════════════════════════════════════════════════

describe('④ 违背检测 · 只报疑似，不终判', () => {
  const injected = (store: MemoryStore) => {
    addPrinciple(store, {
      id: 'p1',
      content: '推荐餐厅前确认同行人忌口',
      condition: '推荐餐厅时',
      action: '确认同行人的饮食忌口',
    });
    return selectPrinciples({ store, task: '推荐餐厅' });
  };

  it('产出里提到相关要求 → 认为遵守', () => {
    const { store } = setup();
    const picked = injected(store);

    const r = checkPrinciples({
      injected: picked,
      reports: [{ servant: 'life', text: '已确认同行人饮食忌口，小李素食' }],
    });

    expect(r.violated).toHaveLength(0);
    expect(r.checks[0]?.satisfied).toBe(true);
  });

  it('★ 产出完全没提 → 报为疑似违背', () => {
    const { store } = setup();
    const picked = injected(store);

    const r = checkPrinciples({
      injected: picked,
      reports: [{ servant: 'life', text: '推荐了三家评分很高的餐厅' }],
    });

    expect(r.violated).toHaveLength(1);
    expect(r.violated[0]?.evidence).toContain('疑似违背');
    expect(r.violated[0]?.evidence).toContain('复核');
  });

  it('多个仆人中有任一提及即认为遵守', () => {
    const { store } = setup();
    const picked = injected(store);

    const r = checkPrinciples({
      injected: picked,
      reports: [
        { servant: 'life', text: '推荐了三家餐厅' },
        { servant: 'health', text: '已核对同行人饮食忌口' },
      ],
    });
    expect(r.violated).toHaveLength(0);
  });

  it('违背落 supervisor.principleViolated 事件，并标注需复核', () => {
    const { store, log, clock } = setup();
    const picked = injected(store);
    const r = checkPrinciples({
      injected: picked,
      reports: [{ servant: 'life', text: '推荐了三家餐厅' }],
    });

    for (const v of r.violated) {
      recordViolation({ log, taskId: 's1', check: v, clock });
    }

    const ev = log.byType('supervisor.principleViolated');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { note?: string }).note).toContain('复核');
  });

  it('没有注入原则时检测结果为空', () => {
    const r = checkPrinciples({ injected: [], reports: [{ servant: 'life', text: 'x' }] });
    expect(r.checks).toHaveLength(0);
    expect(r.violated).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 效果记录
// ═══════════════════════════════════════════════════════════

describe('⑤ 效果记录 · succeeded 只记奏效', () => {
  it('奏效时 succeeded +1', () => {
    const { store, log, clock } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '餐厅忌口',
      condition: '推荐餐厅',
      action: '确认忌口',
      applied: 3,
      succeeded: 2,
    });

    recordEffect({
      log,
      store,
      clock,
      taskId: 's1',
      principleId: 'p1',
      effective: true,
      note: '用户采纳',
    });

    expect(store.get('p1')?.effectiveness?.succeeded).toBe(3);
    expect(log.byType('principle.effectMeasured')).toHaveLength(1);
  });

  it('★ 未奏效时 succeeded 不增（applied 已计过）', () => {
    const { store, log, clock } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: '餐厅忌口',
      condition: '推荐餐厅',
      action: '确认忌口',
      applied: 3,
      succeeded: 2,
    });

    recordEffect({
      log,
      store,
      clock,
      taskId: 's1',
      principleId: 'p1',
      effective: false,
      note: '用户纠正',
    });

    expect(store.get('p1')?.effectiveness?.succeeded).toBe(2);
    expect(store.get('p1')?.effectiveness?.applied).toBe(3);
    // 事件里如实标记
    expect(
      (log.byType('principle.effectMeasured')[0]?.payload as { effective?: boolean }).effective,
    ).toBe(false);
  });

  it('对不存在的原则静默忽略（不抛错）', () => {
    const { store, log, clock } = setup();
    expect(() =>
      recordEffect({ log, store, clock, taskId: 's1', principleId: 'nope', effective: true }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 统计（成长对比用）
// ═══════════════════════════════════════════════════════════

describe('⑥ 原则统计 · 供界面成长对比', () => {
  it('统计总数、生效数、应用与奏效次数', () => {
    const { store } = setup();
    addPrinciple(store, {
      id: 'p1',
      content: 'a',
      condition: '推荐餐厅',
      action: '确认忌口',
      applied: 5,
      succeeded: 4,
    });
    addPrinciple(store, {
      id: 'p2',
      content: 'b',
      condition: '安排时间',
      action: '确认工作日',
      applied: 3,
      succeeded: 3,
    });

    const s = principleStats(store);
    expect(s.total).toBe(2);
    expect(s.active).toBe(2);
    expect(s.everApplied).toBe(2);
    expect(s.applied).toBe(8);
    expect(s.succeeded).toBe(7);
    expect(s.avgSuccessRate).toBeCloseTo(7 / 8, 5);
  });

  it('无原则时统计为零且不除零', () => {
    const { store } = setup();
    const s = principleStats(store);
    expect(s.total).toBe(0);
    expect(s.avgSuccessRate).toBe(0);
  });
});
