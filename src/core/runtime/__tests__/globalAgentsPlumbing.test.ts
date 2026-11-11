/**
 * 编排层注入边界（runSession）
 *
 * ★ 单函数测试证明“每个函数会/不会用全局规则”；
 *   这条测试证明**编排层确实按设计接线**：
 *
 *     契约       ← 全局规则，不接人格
 *     执行/答复  ← 全局规则 + 人格
 *     监督员     ← 都不接
 */

import { describe, expect, it } from 'vitest';

import { runSession } from '../orchestrator.js';
import { EventLog } from '../../events/log.js';
import {
  msg,
  type ModelCall,
  type ModelPort,
  type StructuredCall,
  type StructuredResult,
} from '../../ports/model.js';
import type { GlobalAgentsSnapshot } from '../../prompts/globalAgents.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };
const GLOBAL_MARKER = 'GLOBAL_MARKER_编排层';
const PERSONA_MARKER = 'PERSONA_MARKER_编排层';
const GLOBAL: GlobalAgentsSnapshot = {
  text: GLOBAL_MARKER,
  hash: 'b'.repeat(64),
  length: GLOBAL_MARKER.length,
  loaded: true,
  truncated: false,
};

function bySchema(captured: Array<{ name: string; call: ModelCall }>, name: string): ModelCall | undefined {
  return captured.find((c) => c.name === name)?.call;
}

function model(captured: Array<{ name: string; call: ModelCall }>): ModelPort {
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
      captured.push({ name: call.schemaName, call });
      const value =
        call.schemaName === 'TaskContract'
          ? {
              deliverable: '一份答复',
              criteria: ['能回答问题'],
              mustObey: [],
              domains: ['life'],
              confidence: 0.9,
            }
          : call.schemaName === 'ExecutionReport'
            ? {
                reply: '好的',
                status: 'done',
                artifacts: [],
                uncertainties: [],
                findings: [],
              }
            : {
                criteriaChecks: [{ criterion: '能回答问题', met: true }],
                findings: [],
                summary: 'ok',
              };
      return Promise.resolve({
        value: value as T,
        usage: { inputTokens: 1, outputTokens: 1 },
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
  };
}

describe('runSession 的注入边界', () => {
  it('全局规则进契约/执行；主回合不再自动调用监督员', async () => {
    const captured: Array<{ name: string; call: ModelCall }> = [];
    const result = await runSession({
      model: model(captured),
      clock,
      sessionId: 's',
      userGoal: '帮我安排晚饭',
      persona: PERSONA_MARKER,
      globalAgents: GLOBAL,
      recalled: [],
      log: new EventLog('s'),
      supervisionMode: 'auto',
    });

    expect(result.contract).toBeDefined();

    const contract = bySchema(captured, 'TaskContract');
    const execution = bySchema(captured, 'ExecutionReport');
    const supervision = bySchema(captured, 'SupervisionOutput');

    expect(contract).toBeDefined();
    expect(execution).toBeDefined();
    expect(supervision).toBeUndefined();

    const contractText = JSON.stringify(contract!.messages);
    const executionText = JSON.stringify(execution!.messages);

    // 全局规则：契约 ✓ 执行 ✓
    expect(contractText).toContain(GLOBAL_MARKER);
    expect(executionText).toContain(GLOBAL_MARKER);

    // 人格：契约 ✗ 执行 ✓
    expect(contractText).not.toContain(PERSONA_MARKER);
    expect(executionText).toContain(PERSONA_MARKER);
  });

  it('执行模型能看到前几轮历史，而不是只看本轮原话', async () => {
    const captured: Array<{ name: string; call: ModelCall }> = [];
    const marker = 'HISTORY_MARKER_上一轮';
    await runSession({
      model: model(captured),
      clock,
      sessionId: 's',
      userGoal: '你刚才在做什么',
      history: [msg.system(marker)],
      recalled: [],
      log: new EventLog('s'),
    });

    const execution = bySchema(captured, 'ExecutionReport');
    expect(execution).toBeDefined();
    expect(JSON.stringify(execution!.messages)).toContain(marker);
  });
});
