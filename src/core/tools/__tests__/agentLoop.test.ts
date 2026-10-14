/**
 * Agent 工具循环测试
 *
 * 三类重点：
 *   ① 循环能正确跑完（模型调工具 → 执行 → 回喂 → 出结论）
 *   ② **参数校验挡住模型写错的参数**，并给出可纠正的反馈
 *   ③ **权限闸门无法被绕过** —— 循环不直接调用工具实现
 */

import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { MockModel } from '../../../adapters/model/mock.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { msg, type ModelCall, type ModelResponse, type ModelPort } from '../../ports/model.js';
import { fileTools } from '../builtin/file.js';
import { ToolFramework } from '../framework.js';
import {
  DEFAULT_MAX_ROUNDS,
  MAX_TOOL_RESULTS_IN_HISTORY,
  runAgentLoop,
  trimHistory,
} from '../agentLoop.js';
import type { ActionTier, Authorization, PermissionPolicy } from '../types.js';

const T0 = 1_760_000_000_000;

// ═══════════════════════════════════════════════════════════
// 可编程模型：按轮次返回预设的工具调用
// ═══════════════════════════════════════════════════════════

interface Turn {
  readonly text?: string;
  readonly toolCalls?: readonly { name: string; args: unknown; id?: string }[];
}

class ScriptedModel implements ModelPort {
  private index = 0;
  readonly seen: ModelCall[] = [];

  constructor(private readonly turns: readonly Turn[]) {}

  describe() {
    return { provider: 'scripted', model: 'test' };
  }

  async complete(call: ModelCall): Promise<ModelResponse> {
    this.seen.push(call);
    const turn = this.turns[this.index] ?? { text: '(脚本用尽)' };
    this.index += 1;

    const tcs = (turn.toolCalls ?? []).map((tc, i) => ({
      kind: 'toolCall' as const,
      callId: tc.id ?? `call_${this.index}_${i}`,
      name: tc.name,
      args: tc.args,
    }));

    return {
      text: turn.text ?? '',
      toolCalls: tcs,
      finishReason: tcs.length > 0 ? 'toolCalls' : 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'test',
    };
  }

  async completeStructured(): Promise<never> {
    throw new Error('本测试不使用结构化输出');
  }
}

class Policy implements PermissionPolicy {
  readonly asked: string[] = [];
  constructor(
    private readonly answer: Authorization = 'allow',
    private readonly tiers: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk', 'dangerous'],
  ) {}
  isRemembered(): boolean {
    return false;
  }
  isTierEnabled(t: ActionTier): boolean {
    return this.tiers.includes(t);
  }
  async ask(req: { toolName: string }): Promise<Exclude<Authorization, 'blocked'>> {
    this.asked.push(req.toolName);
    return this.answer === 'blocked' ? 'deny' : this.answer;
  }
}

function setup(turns: readonly Turn[], answer: Authorization = 'allow') {
  const log = new EventLog('s_loop');
  const clock = new FixedClock(T0);
  const fs = new MemoryFileSystem({ now: T0 });
  const policy = new Policy(answer);
  const tools = new ToolFramework({ log, clock, policy });
  tools.registerAll(fileTools(fs));
  const model = new ScriptedModel(turns);
  return { log, clock, fs, policy, tools, model };
}

const run = (s: ReturnType<typeof setup>, maxRounds?: number) =>
  runAgentLoop(
    {
      model: s.model,
      tools: s.tools,
      log: s.log,
      clock: s.clock,
      taskId: 't1',
      ...(maxRounds !== undefined ? { maxRounds } : {}),
    },
    [msg.system('你是生活仆人'), msg.user('看一下 a.txt 里写了什么')],
  );

// ═══════════════════════════════════════════════════════════
// ① 循环基本行为
// ═══════════════════════════════════════════════════════════

describe('① 循环基本行为', () => {
  it('模型直接给答案时不调用任何工具', async () => {
    const s = setup([{ text: '不需要工具，答案是 42' }]);
    const r = await run(s);

    expect(r.finalText).toBe('不需要工具，答案是 42');
    expect(r.traces).toHaveLength(0);
    expect(r.rounds).toBe(1);
    expect(r.hitRoundLimit).toBe(false);
  });

  it('★ 调工具 → 拿到结果 → 给出结论', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: '文件里写的是：你好' },
    ]);
    s.fs.seedFile('a.txt', '你好');

    const r = await run(s);

    expect(r.traces).toHaveLength(1);
    expect(r.traces[0]?.toolName).toBe('read_file');
    expect(r.traces[0]?.ok).toBe(true);
    expect(r.traces[0]?.output).toBe('你好');
    expect(r.finalText).toBe('文件里写的是：你好');
    expect(r.rounds).toBe(2);
  });

  it('★ 工具结果被回喂给模型（下一轮能看到）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'done' },
    ]);
    s.fs.seedFile('a.txt', '文件内容XYZ');

    await run(s);

    // 第二轮调用的消息里应含第一轮的结果
    const secondCall = s.model.seen[1];
    const flattened = JSON.stringify(secondCall?.messages ?? []);
    expect(flattened).toContain('文件内容XYZ');
  });

  it('支持一轮里多个工具调用', async () => {
    const s = setup([
      {
        toolCalls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'read_file', args: { path: 'b.txt' } },
        ],
      },
      { text: '都读到了' },
    ]);
    s.fs.seedFile('a.txt', 'A');
    s.fs.seedFile('b.txt', 'B');

    const r = await run(s);
    expect(r.traces).toHaveLength(2);
    expect(r.traces.map((t) => t.output)).toEqual(['A', 'B']);
  });

  it('记录轮次与用量', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'ok' },
    ]);
    s.fs.seedFile('a.txt', 'x');

    const r = await run(s);
    expect(r.rounds).toBe(3);
    expect(r.usage.inputTokens).toBe(300);
    expect(r.usage.outputTokens).toBe(150);
  });

  it('把工具声明暴露给模型', async () => {
    const s = setup([{ text: 'ok' }]);
    await run(s);
    const tools = s.model.seen[0]?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('read_file');
  });

  it('按过滤器收窄可用工具', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const tools = new ToolFramework({ log, clock, policy: new Policy() });
    tools.registerAll(fileTools(fs));
    const model = new ScriptedModel([{ text: 'ok' }]);

    await runAgentLoop(
      {
        model,
        tools,
        log,
        clock,
        taskId: 't',
        toolFilter: (t) => t.tier === 'readOnly',
      },
      [msg.user('x')],
    );

    const names = (model.seen[0]?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('remove_path');
    expect(names).toContain('read_file');
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 参数校验
// ═══════════════════════════════════════════════════════════

describe('② ★ 参数校验挡住写错的参数', () => {
  it('★ 缺少必填参数时给出可纠正的反馈（而不是执行报错）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: {} }] },
      { text: '我漏了参数' },
    ]);

    const r = await run(s);

    expect(r.traces[0]?.validated).toBe(false);
    expect(r.traces[0]?.validationMessage).toContain('缺少必填参数');
    expect(r.traces[0]?.validationMessage).toContain('path');
    // ★ 没有真的执行
    expect(r.traces[0]?.output).toBeUndefined();
  });

  it('★ 参数类型错误时明确说明类型', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: { nested: 'obj' } } }] },
      { text: 'ok' },
    ]);

    const r = await run(s);
    expect(r.traces[0]?.validationMessage).toContain('应为字符串');
    expect(r.traces[0]?.validationMessage).toContain('object');
  });

  it('★ 温和纠正：数字写成字符串仍然通过', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt', maxBytes: '10' } }] },
      { text: 'ok' },
    ]);
    s.fs.seedFile('a.txt', 'x'.repeat(100));

    const r = await run(s);
    // 校验通过（已规范化为数字 10），然后按 10 字节上限失败
    expect(r.traces[0]?.validated).toBe(true);
    expect(r.traces[0]?.output).toContain('超过上限');
  });

  it('校验失败会落事件（"模型反复写错参数"要看得见）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: {} }] },
      { text: 'ok' },
    ]);
    await run(s);

    const ev = s.log.byType('tool.call');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0]?.payload).toMatchObject({ validationFailed: true, toolName: 'read_file' });
  });

  it('未知工具时列出可用工具（帮模型自我纠正）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'nonexistent_tool', args: {} }] },
      { text: 'ok' },
    ]);

    const r = await run(s);
    expect(r.traces[0]?.ok).toBe(false);
    expect(r.traces[0]?.validationMessage).toContain('未知工具');
    expect(r.traces[0]?.validationMessage).toContain('read_file');
  });

  it('数组参数类型错误被挡住（args 传字符串）', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const tools = new ToolFramework({ log, clock, policy: new Policy() });
    tools.registerAll(fileTools(fs));
    // 手工注册一个带数组参数的工具
    tools.register({
      name: 'multi',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
        required: ['items'],
      },
      tier: 'readOnly',
      summarize: () => 'x',
      execute: async () => ({ ok: true, output: 'ok', durationMs: 1 }),
    });

    const model = new ScriptedModel([
      { toolCalls: [{ name: 'multi', args: { items: 'not-array' } }] },
      { text: 'ok' },
    ]);
    const r = await runAgentLoop(
      { model, tools, log, clock, taskId: 't' },
      [msg.user('x')],
    );
    expect(r.traces[0]?.validated).toBe(false);
    expect(r.traces[0]?.validationMessage).toContain('应为数组');
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 权限闸门无法绕过
// ═══════════════════════════════════════════════════════════

describe('③ ★ 权限闸门在循环里依然生效', () => {
  it('★ 用户拒绝时工具不执行，循环如实告知模型', async () => {
    const s = setup(
      [
        { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
        { text: '用户不允许，我换个办法' },
      ],
      'deny',
    );

    const r = await run(s);

    expect(r.traces[0]?.denied).toBe(true);
    expect(r.traces[0]?.ok).toBe(false);
    // ★ 文件没被创建
    expect(await s.fs.exists('a.txt')).toBe(false);
    // 拒绝信息回喂给模型，让它能换方案
    expect(r.traces[0]?.output).toContain('拒绝');
  });

  it('★ dangerous 级别未开启时循环也执行不了', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    fs.seedFile('a.txt', 'x');
    const policy = new Policy('allow', ['readOnly', 'normal', 'highRisk']);
    const tools = new ToolFramework({ log, clock, policy });
    tools.registerAll(fileTools(fs));
    const model = new ScriptedModel([
      { toolCalls: [{ name: 'remove_path', args: { path: 'a.txt' } }] },
      { text: '删不掉' },
    ]);

    const r = await runAgentLoop({ model, tools, log, clock, taskId: 't' }, [msg.user('删掉它')]);

    expect(r.traces[0]?.ok).toBe(false);
    expect(await fs.exists('a.txt')).toBe(true);
    // 级别未开启时连问都不问
    expect(policy.asked).toHaveLength(0);
  });

  it('只读工具不打扰用户，写操作才问', async () => {
    const s = setup([
      {
        toolCalls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'write_file', args: { path: 'b.txt', content: 'x' } },
        ],
      },
      { text: 'ok' },
    ]);
    s.fs.seedFile('a.txt', 'y');

    await run(s);
    expect(s.policy.asked).toEqual(['write_file']);
  });

  it('★ 每次工具调用都落 tool.call 事件（全量审计）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'ok' },
    ]);
    s.fs.seedFile('a.txt', 'x');
    await run(s);

    const calls = s.log.byType('tool.call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ toolName: 'read_file', tier: 'readOnly', round: 1 });
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 有界性
// ═══════════════════════════════════════════════════════════

describe('④ ★ 循环有界（防止烧光 token）', () => {
  it('★ 达到轮次上限时中止并留痕', async () => {
    // 模型永远在调工具，不给答案
    const forever: Turn[] = Array.from({ length: 30 }, () => ({
      toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }],
    }));
    const s = setup(forever);
    s.fs.seedFile('a.txt', 'x');

    const r = await run(s, 3);

    expect(r.hitRoundLimit).toBe(true);
    expect(r.rounds).toBe(3);
    // ★ 关键：没有无限循环下去
    expect(s.model.seen).toHaveLength(3);
    // 中止原因落事件
    const ev = s.log.byType('supervisor.observe');
    expect(ev.some((e) => (e.payload as { reason?: string }).reason === 'agent_round_limit')).toBe(true);
  });

  it('默认上限是 8 轮', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(8);
  });

  it('★ 历史里的工具结果被裁剪（控制上下文增长）', () => {
    const messages = [msg.user('起点')];
    for (let i = 0; i < MAX_TOOL_RESULTS_IN_HISTORY + 5; i++) {
      messages.push(msg.toolResult(`c${i}`, `结果 ${i}`));
    }

    trimHistory(messages);

    const placeholders = JSON.stringify(messages).match(/已省略以控制上下文/g) ?? [];
    expect(placeholders).toHaveLength(5);
    // 最近的结果仍然完整
    expect(JSON.stringify(messages)).toContain(`结果 ${MAX_TOOL_RESULTS_IN_HISTORY + 4}`);
  });

  it('裁剪不影响没有超量的历史', () => {
    const messages = [msg.user('a'), msg.toolResult('c1', '结果')];
    const before = JSON.stringify(messages);
    trimHistory(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('过长的工具结果被截断', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const tools = new ToolFramework({ log, clock, policy: new Policy() });
    tools.register({
      name: 'huge',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      tier: 'readOnly',
      summarize: () => 'x',
      execute: async () => ({ ok: true, output: 'z'.repeat(20000), durationMs: 1 }),
    });
    const model = new ScriptedModel([
      { toolCalls: [{ name: 'huge', args: {} }] },
      { text: 'ok' },
    ]);

    const r = await runAgentLoop({ model, tools, log, clock, taskId: 't' }, [msg.user('x')]);
    expect(r.traces[0]?.output?.length).toBeLessThan(4200);
    expect(r.traces[0]?.output).toContain('已截断');
  });
});

// ═══════════════════════════════════════════════════════════
// MockModel 集成（确认真实结构的模型也能驱动）
// ═══════════════════════════════════════════════════════════

describe('与其他模型实现协作', () => {
  it('MockModel 的 JSON 输出不会干扰工具循环（无 toolCalls 时直接结束）', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const tools = new ToolFramework({ log, clock, policy: new Policy() });
    tools.registerAll(fileTools(new MemoryFileSystem({ now: T0 })));
    const mock = new MockModel({ script: [{ respond: { kind: 'text', text: '无工具答案' } }] });

    const r = await runAgentLoop({ model: mock, tools, log, clock, taskId: 't' }, [msg.user('x')]);
    expect(r.finalText).toBe('无工具答案');
    expect(r.traces).toHaveLength(0);
  });
});
