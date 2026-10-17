/**
 * 任务契约测试 —— v7 架构改造的核心新概念（D-5）
 *
 * 核心要回答：为什么需要契约？它和旧的 dispatchPlan 差在哪？
 *   · ① 契约是**成文标准**，能被逐条核对（旧的交叉检查做不到）
 *   · ② 契约**不含步骤与派发对象**（只有一个执行者）
 *   · ③ 领域标签是**并集**（模型判断 ∪ 启发式补充），且判不出就空
 *   · ④ 硬约束无条件注入，其余按相关性
 *   · ⑤ 契约必须落事件（它是监督员核对的唯一标准，本身要可审计）
 */

import { describe, expect, it } from 'vitest';

import { renderContractForReview, writeContract } from '../contract.js';
import { EventLog } from '../../events/log.js';
import type { ModelPort, StructuredCall, StructuredResult } from '../../ports/model.js';
import type { ScoredMemory } from '../../memory/recall.js';
import type { MemoryEntry } from '../../memory/types.js';

const T0 = 1_760_000_000_000;

function mem(id: string, content: string, memClass: string): ScoredMemory {
  return {
    memory: {
      id,
      memClass,
      kind: 'fact',
      content,
      confidence: 0.9,
      evidence: [],
      fitness: 0.8,
      lifecycle: 'active',
      lastHitAt: null,
      hitCount: 0,
      revivedCount: 0,
      scope: memClass === 'domain' ? 'domain' : 'global',
      version: 1,
      owner: { kind: 'butler', userId: 'u' },
      createdAt: T0,
      updatedAt: T0,
      useCount: 0,
    } as unknown as MemoryEntry,
    score: 0.8,
    relevance: 0.9,
    fitness: 0.8,
    confidence: 0.9,
    exploratory: false,
    why: '',
  } as ScoredMemory;
}

/** 造一个只回契约的假模型 */
function stubModel(plan: {
  deliverable: string;
  criteria: string[];
  mustObey: string[];
  domains: string[];
}): ModelPort {
  return {
    complete: () => Promise.resolve({ text: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, model: 'stub' }),
    completeStructured: <T>(_c: StructuredCall<T>): Promise<StructuredResult<T>> =>
      Promise.resolve({
        value: plan as unknown as T,
        usage: { inputTokens: 100, outputTokens: 50 },
        attempts: 1,
        promptVersion: 'test',
      }),
    describe: () => ({
      provider: 'stub',
      model: 'stub',
      capabilities: { supportsVision: false, supportsStreaming: true, supportsTools: true, supportsThinking: false },
    }),
  } as unknown as ModelPort;
}

async function run(
  plan: { deliverable: string; criteria: string[]; mustObey: string[]; domains: string[] },
  recalled: readonly ScoredMemory[] = [],
  userGoal = '帮我安排晚饭，我花生过敏',
) {
  const log = new EventLog('s');
  const r = await writeContract({
    model: stubModel(plan),
    log,
    sessionId: 's',
    userGoal,
    recalled,
    now: T0,
  });
  return { r, log };
}

describe('① 契约的四个部分', () => {
  it('交付物 / 判据 / 必须遵守 / 领域 都在', async () => {
    const { r } = await run({
      deliverable: '三套晚餐方案',
      criteria: ['每套不含花生', '给出具体用量'],
      mustObey: ['花生过敏'],
      domains: ['life', 'health'],
    });
    expect(r.contract.deliverable).toBe('三套晚餐方案');
    expect(r.contract.criteria).toHaveLength(2);
    expect(r.contract.mustObey).toEqual(['花生过敏']);
    expect(r.contract.domains).toEqual(expect.arrayContaining(['life', 'health']));
  });

  it('★ 契约**不含**步骤与派发对象（旧 dispatchPlan 的结构）', async () => {
    const { r } = await run({
      deliverable: 'x',
      criteria: ['y'],
      mustObey: [],
      domains: ['life'],
    });
    // 旧结构有 steps / stepId / servant；契约不该有
    expect('steps' in r.contract).toBe(false);
    expect('steps' in r.contract.raw).toBe(false);
  });
});

describe('② 领域标签：并集，且判不出就空', () => {
  it('模型判断的领域被采纳', async () => {
    const { r } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['work'] }, [], '写个周报');
    expect(r.contract.domains).toContain('work');
  });

  it('★ 启发式能补上模型漏掉的领域（并集）', async () => {
    // 模型只说 life，但用户话里有"过敏"→ 启发式会补 health
    const { r } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life'] });
    expect(r.contract.domains).toContain('health');
    expect(r.contract.domains).toContain('life');
  });

  it('★★ 模型填 none 时不硬塞领域（只留启发式的判断）', async () => {
    const { r } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['none'] }, [], '嗯');
    expect(r.contract.domains).toEqual([]);
  });

  it('领域去重（不会出现重复标签）', async () => {
    const { r } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life', 'life'] }, [], '买菜');
    const lives = r.contract.domains.filter((d) => d === 'life');
    expect(lives).toHaveLength(1);
  });
});

describe('③ 约束注入', () => {
  it('硬约束无条件注入，且标记为不可协商', async () => {
    const { r } = await run(
      { deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life'] },
      [mem('m1', '花生过敏', 'global_constraint')],
    );
    const c = r.constraints.find((x) => x.memoryId === 'm1');
    expect(c).toBeDefined();
    expect(c?.negotiable).toBe(false);
  });

  it('软约束也可注入，但标记为可协商', async () => {
    const { r } = await run(
      { deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life'] },
      [mem('m2', '偏好清淡', 'global_shared')],
    );
    const c = r.constraints.find((x) => x.memoryId === 'm2');
    expect(c?.negotiable).toBe(true);
  });
});

describe('④ 契约必须落事件（它是监督员核对的唯一标准）', () => {
  it('★ 落 contract.written，且含完整契约内容', async () => {
    const { log } = await run({
      deliverable: '三套方案',
      criteria: ['不含花生'],
      mustObey: ['花生过敏'],
      domains: ['life'],
    });
    const ev = log.byType('contract.written');
    expect(ev).toHaveLength(1);
    const p = ev[0]?.payload as Record<string, unknown>;
    expect(p['deliverable']).toBe('三套方案');
    expect(p['criteria']).toEqual(['不含花生']);
    expect(p['mustObey']).toEqual(['花生过敏']);
  });

  it('★ 事件里区分"模型判断的领域"与"启发式补充的领域"（可追溯）', async () => {
    const { log } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life'] });
    const p = log.byType('contract.written')[0]?.payload as Record<string, unknown>;
    expect(p['domainsFromModel']).toEqual(['life']);
    expect(Array.isArray(p['domainsFromHeuristic'])).toBe(true);
  });
});

describe('⑤ 渲染给监督员的核对清单', () => {
  it('★ 判据被逐条编号（监督员要能指名"第几条没满足"）', async () => {
    const { r } = await run({
      deliverable: '三套方案',
      criteria: ['每套不含花生', '给出具体用量'],
      mustObey: [],
      domains: ['life'],
    });
    const text = renderContractForReview(r.contract);
    expect(text).toContain('1. 每套不含花生');
    expect(text).toContain('2. 给出具体用量');
  });

  it('★ 硬约束单独成段并标注"违反即不合格"', async () => {
    const { r } = await run({
      deliverable: 'x',
      criteria: ['y'],
      mustObey: ['花生过敏'],
      domains: ['life'],
    });
    const text = renderContractForReview(r.contract);
    expect(text).toContain('必须遵守');
    expect(text).toContain('违反即不合格');
    expect(text).toContain('花生过敏');
  });

  it('没有硬约束时不渲染那一段（不留空标题）', async () => {
    const { r } = await run({ deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['life'] });
    const text = renderContractForReview(r.contract);
    expect(text).not.toContain('必须遵守');
  });
});
