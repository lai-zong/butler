/**
 * 工具循环里的推理强度透传
 *
 * ★ 执行阶段走的是 agentLoop，不是 runButler 的直调路径。
 *   如果只把 plan 传给 runButler 而忘了 agentLoop，
 *   “执行中真正发给模型的强度”就会静默丢失 —— 事件里却写着 applied=max。
 */

import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../agentLoop.js';
import { ToolFramework } from '../framework.js';
import { EventLog } from '../../events/log.js';
import { msg } from '../../ports/model.js';
import type { ModelPort } from '../../ports/model.js';
import type { ModelStreamPort, StreamCall } from '../../ports/stream.js';
import type { PermissionPolicy } from '../types.js';
import { planReasoning } from '../../model/reasoning.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };

const policy: PermissionPolicy = {
  isRemembered: () => false,
  ask: () => Promise.resolve('allow'),
  isTierEnabled: () => true,
};

function fakeModel(): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'stub',
      }),
    completeStructured: () => Promise.reject(new Error('不应调用')),
    describe: () => ({
      provider: 'stub',
      model: 'stub',
      capabilities: {
        supportsVision: false,
        supportsStreaming: true,
        supportsTools: false,
        supportsThinking: false,
      },
    }),
  };
}

describe('runnerAgentLoop · reasoningPlan', () => {
  it('流式执行把 plan 放进 StreamCall.reasoning', async () => {
    const log = new EventLog('s');
    const tools = new ToolFramework({ log, clock, policy });
    const plan = planReasoning({ level: 'max', provider: 'deepseek', model: 'deepseek-flash' });
    const captured: StreamCall[] = [];
    const port: ModelStreamPort = {
      async *stream(call) {
        captured.push(call);
        yield { kind: 'text' as const, delta: '好的' };
        yield {
          kind: 'done' as const,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'stub',
          fullText: '好的',
          fullReasoning: '',
        };
      },
    };

    await runAgentLoop(
      {
        model: fakeModel(),
        tools,
        log,
        clock,
        taskId: 's',
        streamPort: port,
        reasoningPlan: plan,
      },
      [msg.user('你好')],
    );

    expect(captured[0]!.reasoning).toEqual(plan);
  });
});
