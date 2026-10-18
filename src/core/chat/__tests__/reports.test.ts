/**
 * `toExecutionReportData` 的回归测试（v8 · P1 修复）
 *
 * ★★ 为什么要这个文件：这里修的是**静默失效** —— 不报错、不告警、
 *    只是某两个字段永远是空值。
 *
 *   | 字段 | 旧实现 | 症状 |
 *   |---|---|---|
 *   | `instruction` | 从 `session.steps` 找（恒为 `[]`）| 恒为空串 |
 *   | `injectedConstraints` | 从 `session.steps[i]` 找 | 恒为空数组 |
 *
 *   ⚠️ 这种坏法**不会被任何现有测试发现**：
 *     `steps` 本身是合法空数组，`find` 返回 `undefined`，`?? ''` / `return []`
 *     都是合法分支 —— 类型对、逻辑对、结果错。
 *
 *   ★ 所以断言必须落在**"有数据时字段确实有值"**上，
 *     而不是"没有抛异常"。
 */

import { describe, expect, it } from 'vitest';

import { toExecutionReportData } from '../reports.js';
import type { RunSessionResult } from '../../runtime/orchestrator.js';
import type { TaskContract } from '../../butler/contract.js';
import type { ExecutionReport, InjectedConstraint } from '../../execution/types.js';

const T0 = 1_760_000_000_000;

function contract(): TaskContract {
  return {
    deliverable: '三套可直接执行的晚餐方案',
    criteria: ['每套不含花生'],
    mustObey: ['花生过敏'],
    domains: ['life', 'health'],
    confidence: 0.9,
    raw: { deliverable: 'x', criteria: ['y'], mustObey: [], domains: ['none'], confidence: 0.9 },
  };
}

function report(): ExecutionReport {
  return {
    taskId: 't1',
    domain: 'life',
    status: 'done',
    reply: '给了三套方案',
    artifacts: [{ kind: 'text', content: '方案一：清蒸鲈鱼' }],
    memoryRefs: [],
    uncertainties: [],
    findings: [],
  };
}

function session(opts: {
  readonly withContract?: boolean;
  readonly constraints?: readonly InjectedConstraint[];
}): RunSessionResult {
  return {
    log: undefined,
    routing: { servant: 'life', confidence: 0.9, reason: 'x' },
    confident: true,
    ...(opts.withContract !== false ? { contract: contract() } : {}),
    injectedConstraints: opts.constraints ?? [],
    reports: [report()],
    supervision: { criteriaChecks: [], findings: [], summary: 'ok' },
    hardConstraints: { satisfied: [], violated: [], unhandled: [], blocking: [] },
    principles: { injected: [], checks: [], violated: [] },
    artifacts: [],
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    modelInfo: { provider: 'stub', model: 'stub', capabilities: {} },
    startedAt: T0,
    endedAt: T0,
  } as unknown as RunSessionResult;
}

const HARD: InjectedConstraint = {
  memoryId: 'm1',
  content: '用户对花生严重过敏',
  source: 'global_constraint',
  negotiable: false,
};

describe('★ v8 修复：instruction 恒空（旧实现读恒为 [] 的 steps）', () => {
  it('有契约时，instruction = 契约的交付物', () => {
    const [r] = toExecutionReportData(session({}));
    expect(r?.instruction).toBe('三套可直接执行的晚餐方案');
  });

  it('★ 回归点：instruction **不得**为空（旧实现这里恒为 ""）', () => {
    const [r] = toExecutionReportData(session({}));
    expect(r?.instruction.length).toBeGreaterThan(0);
  });

  it('没有契约时如实返回空串，不编占位符', () => {
    const [r] = toExecutionReportData(session({ withContract: false }));
    expect(r?.instruction).toBe('');
  });
});

describe('★★ v8 修复：injectedConstraints 恒空（旧实现读 steps[i]，恒 undefined）', () => {
  it('有约束时，报告里能看到它们', () => {
    const [r] = toExecutionReportData(session({ constraints: [HARD] }));
    expect(r?.injectedConstraints).toHaveLength(1);
    expect(r?.injectedConstraints[0]?.content).toBe('用户对花生严重过敏');
    expect(r?.injectedConstraints[0]?.negotiable).toBe(false);
  });

  it('★ 回归点：**不得**为空数组（旧实现这里恒为 []）', () => {
    const [r] = toExecutionReportData(session({ constraints: [HARD] }));
    expect(r?.injectedConstraints.length).toBeGreaterThan(0);
  });

  it('可协商标记被如实传递（硬约束 vs 软约束）', () => {
    const soft: InjectedConstraint = { ...HARD, memoryId: 'm2', content: '偏好清淡', negotiable: true };
    const [r] = toExecutionReportData(session({ constraints: [HARD, soft] }));
    expect(r?.injectedConstraints.map((c) => c.negotiable)).toEqual([false, true]);
  });

  it('确实没有约束时为空数组（这是正常状态，不是故障）', () => {
    const [r] = toExecutionReportData(session({ constraints: [] }));
    expect(r?.injectedConstraints).toEqual([]);
  });
});
