import { describe, expect, it } from 'vitest';

import { createTaskPlanState, planTaskTool } from '../builtin/plan.js';

describe('plan_task', () => {
  it('把模型给的计划写成任务契约', async () => {
    const state = createTaskPlanState();
    const tool = planTaskTool(state);
    const result = await tool.execute(
      {
        deliverable: '整理好的文件',
        criteria: ['文件在目标目录', '没有删除原文件'],
        mustObey: ['不要修改工作区外'],
        domains: ['work'],
        confidence: 0.9,
      },
      undefined as never,
    );
    expect(result.ok).toBe(true);
    expect(state.contract?.deliverable).toBe('整理好的文件');
    expect(state.contract?.criteria).toHaveLength(2);
  });

  it('非法契约直接拒绝，不建立半成品', async () => {
    const state = createTaskPlanState();
    const tool = planTaskTool(state);
    await expect(
      tool.execute({ deliverable: '', criteria: [], domains: [], confidence: 2 }, undefined as never),
    ).rejects.toThrow();
    expect(state.contract).toBeNull();
  });
});
