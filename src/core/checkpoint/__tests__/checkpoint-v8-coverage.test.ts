/**
 * 检查点白名单 · v8 当前架构覆盖（批次 T2 的回归测试）
 *
 * ★★ 这个文件防的是**一个"看起来正常、实际不工作"的缺口**：
 *
 *   v8 之前 `CHECKPOINT_RULES` 里的 11 条有 6 条属于已删功能
 *   （`route.decided` / `dispatch.*` / `conflict.*`），当前代码永不产生；
 *   而新架构的三个关键时刻 ——
 *     `contract.written`（承诺了什么）
 *     `butler.executed`（干完了）
 *     `supervisor.observe`（复核结果）
 *   **都不在白名单里**。
 *
 *   后果：时间轴上缺了"它答应做什么""干完了没""复核说了什么"，
 *   只剩 `thought.done` / `memory.recalled` / `artifact.created` 这些周边事件。
 *   ⚠️ 这类缺口**静态检查发现不了**：类型对、逻辑对，只是白名单漏了。
 *
 * ★ 本测试断言的是**当前架构的事件会产生检查点**（不是"旧事件仍能重放"，
 *   那由 `checkpoint.test.ts` 覆盖）。
 */

import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../ports/clock.js';
import { EventLog } from '../../events/log.js';
import { CheckpointManager } from '../manager.js';

const T0 = 1_760_000_000_000;

function fresh(): { readonly log: EventLog; readonly mgr: CheckpointManager; tick: () => number } {
  const clock = new FixedClock(T0);
  const log = new EventLog('s_cp_v8');
  let t = T0;
  const mgr = new CheckpointManager({ log, clock, emitCreatedEvents: false });
  return {
    log,
    mgr,
    tick: () => {
      t += 1_000;
      return t;
    },
  };
}

describe('★ 检查点白名单覆盖当前架构的三个关键时刻', () => {
  it('`contract.written` 成为检查点（"它答应做什么"）', () => {
    const { log, mgr, tick } = fresh();
    log.append({
      type: 'contract.written',
      actor: 'butler',
      payload: {
        sessionId: 's_cp_v8',
        deliverable: '三套可直接执行的晚餐方案',
        criteria: ['不含花生', '每餐油 ≤ 5g', '列出食材用量'],
        mustObey: ['花生过敏'],
        domains: ['life', 'health'],
      },
      createdAt: tick(),
    });

    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('写下契约'));
    expect(cp).toBeDefined();
    // 标签里要能看出"承诺了什么"与"几条判据"
    expect(cp?.label).toContain('三套可直接执行的晚餐方案');
    expect(cp?.label).toContain('3 条判据');
  });

  it('`butler.executed` 成为检查点（"干完了"）', () => {
    const { log, mgr, tick } = fresh();
    log.append({
      type: 'butler.executed',
      actor: 'butler',
      payload: {
        taskId: 's_cp_v8',
        status: 'done',
        rounds: 0,
        artifacts: 2,
        findings: 1,
        uncertainties: 0,
        domains: ['life'],
      },
      createdAt: tick(),
    });

    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('执行完成'));
    expect(cp).toBeDefined();
    expect(cp?.label).toContain('done');
    expect(cp?.label).toContain('2 项产出');
  });

  it('`supervisor.observe` 成为检查点（"复核结果"）', () => {
    const { log, mgr, tick } = fresh();
    log.append({
      type: 'supervisor.observe',
      actor: 'supervisor',
      payload: {
        findingCount: 2,
        droppedFindings: 0,
        criteriaTotal: 3,
        criteriaChecked: 3,
        criteriaMet: 2,
      },
      createdAt: tick(),
    });

    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('复核完成'));
    expect(cp).toBeDefined();
    // ⚠️ 字段名必须是 payload 里真实存在的 criteriaMet/criteriaTotal
    expect(cp?.label).toContain('2/3');
  });

  it('模型输出不规范时，「丢弃 N 条」要显示出来（否则问题被藏起来）', () => {
    const { log, mgr, tick } = fresh();
    log.append({
      type: 'supervisor.observe',
      actor: 'supervisor',
      payload: { findingCount: 1, droppedFindings: 3, criteriaTotal: 0, criteriaChecked: 0, criteriaMet: 0 },
      createdAt: tick(),
    });

    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('复核完成'));
    expect(cp?.label).toContain('丢弃 3 条');
  });

  it('历史事件仍能成为检查点（旧日志回退不能丢）', () => {
    const { log, mgr, tick } = fresh();
    log.append({
      type: 'dispatch.stepDone',
      actor: 'butler',
      payload: { stepId: 's1', servant: 'life' },
      createdAt: tick(),
    });

    mgr.sync();
    expect(mgr.all().some((c) => c.label.includes('s1'))).toBe(true);
  });
});
