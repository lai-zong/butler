/**
 * 全局 AGENTS 的注入边界
 *
 * ★ 用户确认过的设计：
 *   全局规则进：写契约 / 执行答复 / 流式叙述
 *   全局规则不进：监督员 / 记忆提取
 *
 * ★ 人格的边界（同时锁住）：
 *   人格进：执行答复 / 流式叙述
 *   人格不进：写契约 / 监督员
 *
 * ⚠️ 这些边界不能靠“调用方记得别传”—— 这里用捕获到的 messages
 *   逐条断言，改坏任何一处都会失败。
 */

import { describe, expect, it } from 'vitest';

import { writeContract } from '../contract.js';
import { runButler } from '../execute.js';
import { supervise } from '../supervisor.js';
import { runNarration } from '../../stream/narrate.js';
import { extractFacts } from '../../reflection/extractFacts.js';
import { EventLog } from '../../events/log.js';
import { BUTLER_SYSTEM } from '../../prompts/butler.js';
import type { ModelCall, ModelPort, StructuredCall, StructuredResult } from '../../ports/model.js';
import type { ModelMessage } from '../../ports/model.js';
import type { ModelStreamPort, StreamCall } from '../../ports/stream.js';
import type { ExecutionReport } from '../../execution/types.js';
import type { TaskContract } from '../contract.js';
import type { GlobalAgentsSnapshot } from '../../prompts/globalAgents.js';
import { planReasoning } from '../../model/reasoning.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };
const GLOBAL_MARKER = 'GLOBAL_AGENTS_MARKER_不要覆盖平台不变量';
const GLOBAL: GlobalAgentsSnapshot = {
  text: GLOBAL_MARKER,
  hash: 'a'.repeat(64),
  length: GLOBAL_MARKER.length,
  loaded: true,
  truncated: false,
};
const PERSONA_MARKER = 'PERSONA_MARKER_会话人格';

const CONTRACT: TaskContract = {
  deliverable: '一份答复',
  criteria: ['能回答问题'],
  mustObey: [],
  domains: ['life'],
  confidence: 0.8,
  raw: {
    deliverable: '一份答复',
    criteria: ['能回答问题'],
    mustObey: [],
    domains: ['life'],
    confidence: 0.8,
  },
} as TaskContract;

const REPORT: ExecutionReport = {
  taskId: 's',
  domain: 'life',
  status: 'done',
  reply: '好的',
  artifacts: [],
  findings: [],
  uncertainties: [],
  memoryRefs: [],
};

function structuredStub(value: unknown, captured: ModelCall[]): ModelPort {
  return {
    complete: (call: ModelCall) => {
      captured.push(call);
      return Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'stub',
      });
    },
    completeStructured: <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
      captured.push(call);
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

function streamStub(captured: StreamCall[]): ModelStreamPort {
  return {
    async *stream(call) {
      captured.push(call);
      yield {
        kind: 'done' as const,
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'stub',
        fullText: '',
        fullReasoning: '',
      };
    },
  };
}

function systemTexts(messages: readonly ModelMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.map((p) => (p.kind === 'text' ? p.text : '')).join(''));
}

describe('全局 AGENTS 只进入 contract / execute / narrate', () => {
  it('writeContract：BUTLER_SYSTEM 之后、用户目标之前；不含人格', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    await writeContract({
      model: structuredStub(
        {
          deliverable: 'x',
          criteria: ['y'],
          mustObey: [],
          domains: ['life'],
          confidence: 0.9,
        },
        captured,
      ),
      log,
      sessionId: 's',
      userGoal: '帮我安排晚饭',
      recalled: [],
      now: T0,
      globalAgents: GLOBAL,
    });

    const messages = captured[0]!.messages;
    expect(messages[0]!.content[0]!.kind).toBe('text');
    expect((messages[0]!.content[0] as { text: string }).text).toBe(BUTLER_SYSTEM);
    expect(systemTexts(messages)[1]).toContain(GLOBAL_MARKER);
    expect(JSON.stringify(messages)).not.toContain(PERSONA_MARKER);
  });

  it('runButler：BUTLER_SYSTEM → 全局规则 → 人格 → 出题规则 → 历史 → 用户任务', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    await runButler({
      model: structuredStub(REPORT, captured),
      log,
      clock,
      taskId: 's',
      contract: CONTRACT,
      injectedConstraints: [],
      userGoal: '帮我安排晚饭',
      persona: PERSONA_MARKER,
      globalAgents: GLOBAL,
      now: T0,
    });

    const messages = captured[0]!.messages;
    expect((messages[0]!.content[0] as { text: string }).text).toBe(BUTLER_SYSTEM);
    expect((messages[1]!.content[0] as { text: string }).text).toContain(GLOBAL_MARKER);
    expect((messages[2]!.content[0] as { text: string }).text).toContain(PERSONA_MARKER);
    // 顺序：人格在全局规则之后
    expect(JSON.stringify(messages)).toContain(GLOBAL_MARKER);
    expect((messages[3]!.content[0] as { text: string }).text).toContain('出题规则');
    expect(messages[4]!.role).toBe('user');
  });

  it('runButler：技能说明在全局规则之后、人格之前', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    const SKILL_MARKER = 'SKILL_MARKER_周报整理';
    await runButler({
      model: structuredStub(REPORT, captured),
      log,
      clock,
      taskId: 's',
      contract: CONTRACT,
      injectedConstraints: [],
      userGoal: '帮我整理周报',
      persona: PERSONA_MARKER,
      globalAgents: GLOBAL,
      skillInstructions: SKILL_MARKER,
      now: T0,
    });

    const systems = systemTexts(captured[0]!.messages);
    const globalIndex = systems.findIndex((text) => text.includes(GLOBAL_MARKER));
    const skillIndex = systems.findIndex((text) => text.includes(SKILL_MARKER));
    const personaIndex = systems.findIndex((text) => text.includes(PERSONA_MARKER));
    expect(globalIndex).toBeGreaterThanOrEqual(0);
    expect(skillIndex).toBeGreaterThan(globalIndex);
    expect(personaIndex).toBeGreaterThan(skillIndex);
  });

  it('runButler：reasoningPlan 真正传给模型调用', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    const plan = planReasoning({ level: 'max', provider: 'deepseek', model: 'deepseek-flash' });
    await runButler({
      model: structuredStub(REPORT, captured),
      log,
      clock,
      taskId: 's',
      contract: CONTRACT,
      injectedConstraints: [],
      userGoal: '帮我安排晚饭',
      reasoningPlan: plan,
      now: T0,
    });
    expect(captured[0]!.reasoning).toEqual(plan);
  });

  it('runNarration：NARRATION_SYSTEM → 全局规则 → 人格 → 用户；plan 也透传', async () => {
    const captured: StreamCall[] = [];
    const log = new EventLog('s');
    const plan = planReasoning({ level: 'low', provider: 'deepseek', model: 'deepseek-flash' });
    await runNarration({
      port: streamStub(captured),
      log,
      clock,
      taskId: 's',
      userGoal: '帮我安排晚饭',
      persona: PERSONA_MARKER,
      globalAgents: GLOBAL,
      reasoningPlan: plan,
      onUpdate: () => undefined,
    });

    const messages = captured[0]!.messages;
    expect(messages[0]!.role).toBe('system');
    expect((messages[0]!.content[0] as { text: string }).text).toContain('管家');
    expect((messages[1]!.content[0] as { text: string }).text).toContain(GLOBAL_MARKER);
    expect((messages[2]!.content[0] as { text: string }).text).toContain(PERSONA_MARKER);
    expect(messages[3]!.role).toBe('user');
    expect(captured[0]!.reasoning).toEqual(plan);
  });

  it('runNarration：技能说明在全局规则之后、人格之前', async () => {
    const captured: StreamCall[] = [];
    const log = new EventLog('s');
    const SKILL_MARKER = 'SKILL_NARRATION_MARKER';
    await runNarration({
      port: streamStub(captured),
      log,
      clock,
      taskId: 's',
      userGoal: '帮我安排晚饭',
      persona: PERSONA_MARKER,
      globalAgents: GLOBAL,
      skillInstructions: SKILL_MARKER,
      onUpdate: () => undefined,
    });

    const systems = systemTexts(captured[0]!.messages);
    const globalIndex = systems.findIndex((text) => text.includes(GLOBAL_MARKER));
    const skillIndex = systems.findIndex((text) => text.includes(SKILL_MARKER));
    const personaIndex = systems.findIndex((text) => text.includes(PERSONA_MARKER));
    expect(skillIndex).toBeGreaterThan(globalIndex);
    expect(personaIndex).toBeGreaterThan(skillIndex);
  });

  it('supervise：不接收全局规则 / 人格', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    await supervise({
      model: structuredStub(
        { criteriaChecks: [{ criterion: '能回答问题', met: true }], findings: [], summary: 'ok' },
        captured,
      ),
      log,
      userGoal: '帮我安排晚饭',
      contract: CONTRACT,
      reports: [REPORT],
      hardConstraints: [],
      now: T0,
    });

    const text = JSON.stringify(captured[0]!.messages);
    expect(text).not.toContain(GLOBAL_MARKER);
    expect(text).not.toContain(PERSONA_MARKER);
  });

  it('extractFacts：不接收全局规则 / 人格', async () => {
    const captured: ModelCall[] = [];
    const log = new EventLog('s');
    await extractFacts({
      model: structuredStub({ facts: [] }, captured),
      log,
      clock,
      store: {} as never,
      userId: 'u',
      userText: '我叫示例用户',
      existing: [],
    });

    const text = JSON.stringify(captured[0]!.messages);
    expect(text).not.toContain(GLOBAL_MARKER);
    expect(text).not.toContain(PERSONA_MARKER);
  });
});
