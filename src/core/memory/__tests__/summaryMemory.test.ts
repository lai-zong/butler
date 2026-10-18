/**
 * 聚合型记忆（`MemoryKind: 'summary'`）测试 · D-31
 *
 * ★ 要证明的核心不是"多了一个枚举值"，而是：
 *   ① 它能被**创建**（schema 允许模型产出）
 *   ② 它能被**召回**（与其它三类走同一套召回）
 *   ③ 它会**衰减**（不是永久真理）
 *   ④ 它**不是** `ProfileSnapshot`（快照不参与召回，它参与）
 */
import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { MemoryStore } from '../../memory/store.js';
import { FixedClock } from '../../ports/clock.js';
import { recall } from '../../memory/recall.js';
import { decayClassOf } from '../../memory/fitness.js';
import { reflectionSchema } from '../../prompts/schemas.js';

const T0 = 1_760_000_000_000;

function setup() {
  const log = new EventLog('s_summary');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, 'local');
  return { log, clock, store };
}

const SUMMARY =
  '这一周你主要在赶毕业设计：晚上 21 点后效率明显更高，白天多在处理杂事。' +
  '建议把需要深度思考的事排在晚上，白天先清掉沟通类任务。';

describe('★★ 聚合记忆可以被创建并召回', () => {
  it('★ 创建 summary 记忆（走正常 create，不是特例）', () => {
    const { store } = setup();
    const r = store.create({ kind: 'butler', userId: 'local' }, {
      memClass: 'global_shared',
      kind: 'summary',
      content: SUMMARY,
      confidence: 0.7,
      evidence: ['refl_weekly_1'],
      lifecycle: 'active',
    });
    expect(r.ok).toBe(true);
  });

  it('★★ 能被召回（这是它与 ProfileSnapshot 的根本区别）', () => {
    const { store } = setup();
    store.create({ kind: 'butler', userId: 'local' }, {
      memClass: 'global_shared',
      kind: 'summary',
      content: SUMMARY,
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
    });

    /**
     * ⚠️ `recall` 是**纯函数**：它不查仓储，候选要由调用方传入。
     *    第一版我按"高层入口"去调（传 store），测试直接失败 ——
     *    这说明我把接口记错了，而不是召回不工作。
     */
    const r = recall({
      query: '我最近晚上该做什么比较高效？',
      candidates: store.all(),
      limit: 10,
      now: T0,
      random: { next: () => 0.5, pick: <T,>(items: readonly T[]): T | undefined => items[0] } as never,
    });

    // 召回结果里应当出现这条 summary（它是可召回记忆）
    const found = r.selected.some((s) => s.memory.kind === 'summary');
    expect(found).toBe(true);
  });

  it('★ 长内容不被截断（summary 本来就是长文本）', () => {
    const { store } = setup();
    const long = '很长的总结。'.repeat(200); // ~1200 字
    store.create({ kind: 'butler', userId: 'local' }, {
      memClass: 'global_shared',
      kind: 'summary',
      content: long,
      confidence: 0.7,
      evidence: [],
      lifecycle: 'active',
    });
    const all = store.all();
    expect(all[0]?.content.length).toBe(long.length);
  });
});

describe('★★ 它会衰减（不是永久真理）', () => {
  it('summary 的衰减类别是 medium（既不是 none，也不是 fast）', () => {
    const cls = decayClassOf({ memClass: 'global_shared', kind: 'summary' });
    expect(cls).toBe('medium');
  });

  it('硬约束豁免依然优先（summary 不享有这个豁免）', () => {
    // 硬约束 → none（永不衰减）
    expect(decayClassOf({ memClass: 'global_constraint', kind: 'summary' })).toBe('none');
  });
});

describe('★ 模型能产出它（反思 schema 允许）', () => {
  it('reflectionSchema 接受 kind=summary', () => {
    const parsed = reflectionSchema.safeParse({
      candidates: [
        {
          kind: 'summary',
          content: SUMMARY,
          confidence: 0.7,
          evidence: ['e1'],
          rationale: '跨会话汇总',
          memClass: 'global_shared',
        },
      ],
      collaborationIssues: [],
      rhythmChanges: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('★ 非法 kind 仍被拒绝（枚举没有放宽成 string）', () => {
    const parsed = reflectionSchema.safeParse({
      candidates: [
        { kind: 'garbage', content: 'x', confidence: 0.5, evidence: [], rationale: '' },
      ],
      collaborationIssues: [],
      rhythmChanges: [],
    });
    expect(parsed.success).toBe(false);
  });
});
