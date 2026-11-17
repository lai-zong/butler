import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelCall, ModelPort, ModelResponse } from '../../ports/model.js';
import { runButler } from '../execute.js';

const CONTRACT = {
  deliverable: '出题',
  criteria: [],
  mustObey: [],
  domains: ['study'],
  confidence: 1,
  raw: {},
} as never;

function quizRaw() {
  return {
    value: {
      reply: '已根据资料出题。',
      status: 'done',
      artifacts: [
        {
          kind: 'quiz',
          quiz: [
            { id: 'q1', stem: '第一题？', options: ['甲', '乙'], answer: 'A' },
            { id: 'q2', stem: '第二题？', options: ['甲', '乙'], answer: 'B' },
          ],
        },
      ],
      uncertainties: [],
      findings: [],
    },
    usage: { inputTokens: 10, outputTokens: 10 },
    attempts: 1,
  };
}

function fakeModel(): {
  model: ModelPort;
  completeCalls: ModelCall[];
  structuredCalls: ModelCall[];
} {
  const completeCalls: ModelCall[] = [];
  const structuredCalls: ModelCall[] = [];
  const model = {
    async complete(call: ModelCall): Promise<ModelResponse> {
      completeCalls.push(call);
      return {
        text: 'EVIDENCE: notes/数学笔记.md 提到二次函数。',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 3 },
        model: 'fake',
      };
    },
    async completeStructured(call: ModelCall) {
      structuredCalls.push(call);
      return quizRaw();
    },
    describe() {
      return {
        provider: 'fake',
        model: 'fake',
        capabilities: {
          supportsVision: false,
          supportsStreaming: false,
          supportsTools: true,
          supportsThinking: false,
        },
      };
    },
  } as unknown as ModelPort;
  return { model, completeCalls, structuredCalls };
}

function fakeTools(): never {
  return {
    toModelSpecs: () => [
      {
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: {} },
      },
    ],
  } as never;
}

async function run(userGoal: string) {
  const { model, completeCalls, structuredCalls } = fakeModel();
  const log = new EventLog('probe');
  const result = await runButler({
    model,
    log,
    clock: new FixedClock(1_760_000_000_000),
    taskId: 'probe',
    contract: CONTRACT,
    injectedConstraints: [],
    userGoal,
    tools: fakeTools(),
    now: 1_760_000_000_000,
  });
  return { result, log, completeCalls, structuredCalls };
}

describe('出题取证', () => {
  it('★ “先读笔记再出题”会先跑只读取证，再把证据注入结构化出题', async () => {
    const { log, completeCalls, structuredCalls } = await run(
      '先读一下 notes/数学笔记.md，再根据它出 3 道练习题。',
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.tools?.length).toBeGreaterThan(0);
    expect(structuredCalls).toHaveLength(1);
    expect(JSON.stringify(structuredCalls[0]?.messages)).toContain('EVIDENCE:');
    expect(log.byType('quiz.created')).toHaveLength(1);
  });

  it('普通出题不额外调用取证模型', async () => {
    const { completeCalls, structuredCalls } = await run('帮我出三道数学题');
    expect(completeCalls).toHaveLength(0);
    expect(structuredCalls).toHaveLength(1);
  });
});
