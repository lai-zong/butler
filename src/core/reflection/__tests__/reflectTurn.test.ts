/**
 * `reflectTurn` 的领域分组测试（v7 · E4）
 *
 * ★★ 为什么要单独一个文件：
 *
 *   `reflectTurn` 原本**没有任何测试** ——
 *   现有的 23 个反思测试都在测 `buildServantReflectionInput` / `reflectServant`
 *   这两个**下层函数**，`validate:02` 也是直接调下层。
 *
 *   ⚠️ 后果：我在 E4 里改了 `reflectTurn` 的分组依据（`report.servant` → 契约的 `domains`），
 *      1006 个测试全过、validate:02 也过 —— **但那两个都没走这条路径**。
 *      测试全绿在这里**不代表改对了**，只代表没测到。
 *
 * ★ 本文件锁住 E4 的两条不变量：
 *   ① 契约有领域 → 按领域逐个反思
 *   ② 契约**没有**领域 → **不做领域层反思**（只有管家层）
 *      —— 因为"在哪个领域反思"没有答案时，任何归属都是编造
 */

import { describe, expect, it } from 'vitest';

import { reflectTurn } from '../runReflection.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import type { ModelPort } from '../../ports/model.js';
import type { RunSessionResult } from '../../runtime/orchestrator.js';
import type { TaskContract } from '../../butler/contract.js';
import type { ServantReport } from '../../servants/types.js';

const T0 = 1_760_000_000_000;
const USER = 'u_test';

function contract(domains: TaskContract['domains']): TaskContract {
  return {
    deliverable: '三套晚餐方案',
    criteria: ['不含花生'],
    mustObey: ['花生过敏'],
    domains,
    raw: { deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['none'] },
  };
}

function report(): ServantReport {
  return {
    taskId: 't1',
    // ⚠️ 这个字段在 v7 里已经没有语义（E5 会删）。测试里随便填，
    //    因为**分组不该再看它** —— 这正是本文件要证明的事。
    servant: 'life',
    status: 'done',
    reply: '给了三套方案',
    artifacts: [{ kind: 'text', content: '方案一：清蒸鲈鱼' }],
    memoryRefs: [],
    uncertainties: [],
    findings: [],
  };
}

/** 记录被调用次数的假模型：每次 completeStructured 都返回空候选 */
function countingModel(counter: { n: number }): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'stub',
      }),
    completeStructured: () => {
      counter.n += 1;
      return Promise.resolve({
        value: { candidates: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: 1,
        promptVersion: 'test',
      });
    },
    describe: () => ({
      provider: 'stub',
      model: 'stub',
      capabilities: {
        supportsVision: false,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
      },
    }),
  } as unknown as ModelPort;
}

function session(c: TaskContract | undefined): RunSessionResult {
  return {
    log: new EventLog('s'),
    routing: { servant: 'life', confidence: 0.9, reason: 'x' },
    confident: true,
    steps: [],
    ...(c !== undefined ? { contract: c } : {}),
    injectedConstraints: [],
    reports: [report()],
    supervision: { criteriaChecks: [], findings: [], summary: 'ok' },
    hardConstraints: {
      satisfied: [],
      violated: [],
      unhandled: [],
      blocking: [],
    } as unknown as RunSessionResult['hardConstraints'],
    principles: { injected: [], checks: [], violated: [] },
    artifacts: [],
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    modelInfo: { provider: 'stub', model: 'stub', capabilities: {} } as never,
    startedAt: T0,
    endedAt: T0,
  } as unknown as RunSessionResult;
}

async function run(c: TaskContract | undefined): Promise<{ calls: number }> {
  const counter = { n: 0 };
  const log = new EventLog('s');
  await reflectTurn({
    model: countingModel(counter),
    log,
    clock: new FixedClock(T0),
    store: new MemoryStore(log, new FixedClock(T0), USER),
    session: session(c),
    userGoal: '帮我安排晚饭，我花生过敏',
    userId: USER,
    accepted: true,
  });
  return { calls: counter.n };
}

describe('① 契约有领域 → 按领域逐个反思', () => {
  it('单领域：1 次领域反思 + 1 次管家复盘 = 2 次调用', async () => {
    const { calls } = await run(contract(['life']));
    expect(calls).toBe(2);
  });

  it('★ 两个领域：各一次 + 管家一次 = 3 次调用（跨领域各反思各的）', async () => {
    const { calls } = await run(contract(['life', 'health']));
    expect(calls).toBe(3);
  });

  it('领域去重：同一领域写两遍也只反思一次', async () => {
    const { calls } = await run(contract(['life', 'life']));
    expect(calls).toBe(2);
  });
});

describe('② ★★ 契约没有领域 → 不做领域层反思（不编造归属）', () => {
  /**
   * ⚠️ 这是 E4 修的那处缺陷的回归测试。
   *
   * 修之前：`orchestrator` 写 `servant: contract.domains[0] ?? 'life'`，
   *        而 `reflectTurn` 按 `report.servant` 分组 →
   *        **无领域的任务会被归到「生活」领域下反思**。归属是编的。
   *
   * 修之后：领域来源只有契约的 `domains`。为空 → 领域层反思**不跑**。
   *
   * ★ 断言 `calls === 1`（只剩管家层那一发）——
   *   如果哪天有人把 `?? 'life'` 加回来，这里会变成 2，测试立刻红。
   */
  it('domain 为空数组 → 只有管家层反思（1 次调用）', async () => {
    const { calls } = await run(contract([]));
    expect(calls).toBe(1);
  });

  it('session 没有 contract → 同样只有管家层反思', async () => {
    const { calls } = await run(undefined);
    expect(calls).toBe(1);
  });

  it('★★ 关键：即使 report.servant 写着 life，也不因此产生领域反思', async () => {
    // report() 里 servant: 'life' —— 修之前这会触发生活领域的反思
    const { calls } = await run(contract([]));
    expect(calls).toBe(1);
  });
});
