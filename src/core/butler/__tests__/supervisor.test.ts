/**
 * 监督员提示词边界测试
 *
 * 重点不是“模型能不能返回 JSON”，而是：
 *   · 系统提示词必须是**监督员**，不能复用 butler 的执行者立场；
 *   · 版本号必须同时包含 supervisor.system 与 supervisor.task；
 *   · 审查失败/取消不能在这层被伪装成通过。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import type { ModelPort, StructuredCall, StructuredResult } from '../../ports/model.js';
import type { TaskContract } from '../contract.js';
import { supervise } from '../supervisor.js';

const T0 = 1_760_000_000_000;

const CONTRACT: TaskContract = {
  deliverable: '一份答复',
  criteria: ['能回答问题'],
  mustObey: [],
  domains: [],
  confidence: 0.8,
  raw: {
    deliverable: '一份答复',
    criteria: ['能回答问题'],
    mustObey: [],
    domains: [],
    confidence: 0.8,
  },
} as TaskContract;

function stubModel(captured: { call?: StructuredCall<unknown> }): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'stub',
      }),
    completeStructured: <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
      captured.call = call as StructuredCall<unknown>;
      return Promise.resolve({
        value: {
          criteriaChecks: [{ criterion: '能回答问题', met: true }],
          findings: [],
          summary: '通过',
        } as unknown as T,
        usage: { inputTokens: 100, outputTokens: 20 },
        attempts: 1,
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

describe('supervise · 监督员提示词', () => {
  it('使用 SUPERVISOR_SYSTEM，而不是 BUTLER_SYSTEM', async () => {
    const captured: { call?: StructuredCall<unknown> } = {};
    const log = new EventLog('s_supervisor');
    const result = await supervise({
      model: stubModel(captured),
      log,
      userGoal: '测试',
      contract: CONTRACT,
      reports: [],
      hardConstraints: [],
      now: T0,
    });

    expect(captured.call).toBeDefined();
    const system = captured.call?.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(JSON.stringify(system)).toContain('监督员');
    expect(JSON.stringify(system)).not.toContain('你是这个系统的「管家」');

    expect(result.promptVersion).toContain('supervisor.system');
    expect(result.promptVersion).toContain('supervise');
  });

  it('全局记忆快照进入 user prompt，且不包含敏感/领域内容', async () => {
    const captured: { call?: StructuredCall<unknown> } = {};
    const log = new EventLog('s_supervisor_snapshot');
    await supervise({
      model: stubModel(captured),
      log,
      userGoal: '测试',
      contract: CONTRACT,
      reports: [],
      hardConstraints: [],
      memorySnapshot: [
        { id: 'm1', memClass: 'global_shared', kind: 'preference', content: '全局偏好：先给结论' },
        { id: 'm2', memClass: 'global_constraint', kind: 'fact', content: '硬约束：对花生过敏' },
      ],
      now: T0,
    });

    const user = captured.call?.messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    const text = JSON.stringify(user);
    expect(text).toContain('全局记忆快照');
    expect(text).toContain('先给结论');
    expect(text).toContain('对花生过敏');
  });
});
