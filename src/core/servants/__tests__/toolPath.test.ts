/**
 * 仆人工具路径测试
 *
 * 仆人现在有两条执行路径：
 *   · 单次结构化输出（无工具时）—— 省一轮 token
 *   · 工具循环（有工具时）—— 能读写文件、跑命令，最后用 submit_report 交汇报
 *
 * 本文件验证后者，重点是：
 *   ① 汇报通过**终止工具**提交，循环不白跑一轮
 *   ② 领域工具收窄生效（健康仆人拿不到命令执行）
 *   ③ 模型没交汇报时**如实反映为 blocked**，不伪造空汇报
 */

import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelCall, ModelResponse, ModelPort } from '../../ports/model.js';
import { submitReportTool, extractReport } from '../../tools/builtin/report.js';
import { fileTools } from '../../tools/builtin/file.js';
import { ToolFramework } from '../../tools/framework.js';
import type { ActionTier, PermissionPolicy } from '../../tools/types.js';
import type { ServantId } from '../types.js';
import { SERVANT_TOOL_POLICY, runServant } from '../execute.js';

const T0 = 1_760_000_000_000;

interface Turn {
  readonly text?: string;
  readonly toolCalls?: readonly { name: string; args: unknown }[];
}

class ScriptedModel implements ModelPort {
  private index = 0;
  readonly seen: ModelCall[] = [];
  constructor(private readonly turns: readonly Turn[]) {}
  describe() {
    return {
      provider: 'scripted',
      model: 'test',
      // 测试替身声明全能力，避免能力检查把被测逻辑挡住
      capabilities: {
        supportsVision: true,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
      },
    };
  }
  async complete(call: ModelCall): Promise<ModelResponse> {
    this.seen.push(call);
    const turn = this.turns[this.index] ?? { text: '(脚本用尽)' };
    this.index += 1;
    const tcs = (turn.toolCalls ?? []).map((tc, i) => ({
      kind: 'toolCall' as const,
      callId: `c${this.index}_${i}`,
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
    throw new Error('工具路径不该走结构化输出');
  }
}

class Policy implements PermissionPolicy {
  isRemembered() {
    return false;
  }
  isTierEnabled(_t: ActionTier) {
    return true;
  }
  async ask(): Promise<'allow'> {
    return 'allow';
  }
}

function setup(turns: readonly Turn[]) {
  const log = new EventLog('s_sv');
  const clock = new FixedClock(T0);
  const fs = new MemoryFileSystem({ now: T0 });
  const tools = new ToolFramework({ log, clock, policy: new Policy() });
  tools.registerAll(fileTools(fs));
  const model = new ScriptedModel(turns);
  return { log, clock, fs, tools, model };
}

const REPORT = {
  status: 'done',
  artifacts: [{ kind: 'list', content: '糙米 300g\n北豆腐 2 盒' }],
  uncertainties: ['不知道聚餐人数'],
  findings: [{ kind: 'constraintRef', statement: '已排除花生', evidence: ['逐条核对'] }],
};

const run = (s: ReturnType<typeof setup>, servant: ServantId = 'life') =>
  runServant({
    model: s.model,
    log: s.log,
    clock: s.clock,
    tools: s.tools,
    servant,
    taskId: 's1',
    instruction: '列一份采购清单',
    injectedConstraints: [],
    now: T0,
  });

// ═══════════════════════════════════════════════════════════
// ① 终止工具
// ═══════════════════════════════════════════════════════════

describe('① 汇报通过终止工具提交', () => {
  it('★ 调用 submit_report 后循环立即结束（不白跑一轮）', async () => {
    const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
    const r = await run(s);

    expect(r.report.status).toBe('done');
    expect(r.report.artifacts).toHaveLength(1);
    // 只有一轮：没有多问一次"你提交完了吗"
    expect(s.model.seen).toHaveLength(1);
  });

  it('产出物被归一化为条目数组', async () => {
    const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
    const r = await run(s);
    const art = r.report.artifacts[0];
    expect(art?.kind).toBe('list');
    expect(Array.isArray(art?.content)).toBe(true);
    expect(art?.content).toEqual(['糙米 300g', '北豆腐 2 盒']);
  });

  it('findings 被保留（只陈述，不做裁决）', async () => {
    const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
    const r = await run(s);
    expect(r.report.findings).toHaveLength(1);
    expect(r.report.findings?.[0]?.kind).toBe('constraintRef');
  });

  it('uncertainties 被如实保留', async () => {
    const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
    const r = await run(s);
    expect(r.report.uncertainties).toEqual(['不知道聚餐人数']);
  });

  it('★ 格式不合规时循环继续，模型可修正后重交', async () => {
    const s = setup([
      { toolCalls: [{ name: 'submit_report', args: { status: 'done' } }] }, // 缺字段
      { toolCalls: [{ name: 'submit_report', args: REPORT }] },
    ]);
    const r = await run(s);

    expect(r.report.status).toBe('done');
    expect(s.model.seen).toHaveLength(2); // 跑了两轮
  });
});

// ═══════════════════════════════════════════════════════════
// ② 工具使用
// ═══════════════════════════════════════════════════════════

describe('② 仆人能真的用工具', () => {
  it('★ 先读文件再汇报（工具结果影响产出）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'inventory.txt' } }] },
      {
        toolCalls: [
          {
            name: 'submit_report',
            args: { ...REPORT, artifacts: [{ kind: 'list', content: '冰箱里有鸡蛋' }] },
          },
        ],
      },
    ]);
    s.fs.seedFile('inventory.txt', '冰箱里有鸡蛋');

    const r = await run(s);
    expect(s.model.seen).toHaveLength(2);
    expect(r.report.artifacts[0]?.content).toEqual(['冰箱里有鸡蛋']);
  });

  it('★ 写文件也走闸门（有审计）', async () => {
    const s = setup([
      { toolCalls: [{ name: 'write_file', args: { path: 'menu.txt', content: '菜单内容' } }] },
      { toolCalls: [{ name: 'submit_report', args: REPORT }] },
    ]);

    await run(s);

    expect(await s.fs.exists('menu.txt')).toBe(true);
    const audits = s.tools.allAudits();
    expect(audits.some((a) => a.toolName === 'write_file')).toBe(true);
  });

  it('工具调用落 tool.call 与 tool.result 事件', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'submit_report', args: REPORT }] },
    ]);
    s.fs.seedFile('a.txt', 'x');

    await run(s);
    // submit_report 也会走闸门，所以两类事件各有两条
    expect(s.log.byType('tool.call').length).toBeGreaterThanOrEqual(2);
    expect(s.log.byType('tool.result').length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 领域工具收窄
// ═══════════════════════════════════════════════════════════

describe('③ ★ 领域工具收窄（减少误用，不是安全边界）', () => {
  it('生活/学习只拿到 readOnly + normal 级工具', () => {
    expect(SERVANT_TOOL_POLICY.life.allowTiers).toEqual(['readOnly', 'normal']);
    expect(SERVANT_TOOL_POLICY.study.allowTiers).toEqual(['readOnly', 'normal']);
  });

  it('★ 健康仆人只拿到只读工具（它做核对，不做改动）', () => {
    expect(SERVANT_TOOL_POLICY.health.allowTiers).toEqual(['readOnly']);
  });

  it('办公与代码可以拿到 highRisk（移动文件、执行命令）', () => {
    expect(SERVANT_TOOL_POLICY.work.allowTiers).toContain('highRisk');
    expect(SERVANT_TOOL_POLICY.code.allowTiers).toContain('highRisk');
  });

  it('★ 收窄真的生效：健康仆人看不到写文件工具', async () => {
    const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
    await run(s, 'health');

    const names = (s.model.seen[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('submit_report');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('remove_path');
  });

  it('没有人拿到 dangerous 级工具（删除默认不给仆人）', async () => {
    for (const servant of ['life', 'health', 'study', 'work', 'code'] as const) {
      const s = setup([{ toolCalls: [{ name: 'submit_report', args: REPORT }] }]);
      await run(s, servant);
      const names = (s.model.seen[0]?.tools ?? []).map((t) => t.name);
      expect(names, servant).not.toContain('remove_path');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 不伪造汇报
// ═══════════════════════════════════════════════════════════

describe('④ ★ 没交汇报时如实反映，不伪造', () => {
  it('★ 模型一直不交汇报 → status=blocked，并说明原因', async () => {
    const s = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    ]);
    s.fs.seedFile('a.txt', 'x');

    const r = await runServant({
      model: s.model,
      log: s.log,
      clock: s.clock,
      tools: s.tools,
      servant: 'life',
      taskId: 's1',
      instruction: 'x',
      injectedConstraints: [],
      now: T0,
      maxRounds: 2,
    });

    expect(r.report.status).toBe('blocked');
    expect(r.report.artifacts).toHaveLength(0);
    expect(r.report.uncertainties[0]).toContain('轮次上限');
  });

  it('模型直接给文本、不调工具 → 也如实反映为 blocked', async () => {
    const s = setup([{ text: '我直接说结论：清单是……' }]);
    const r = await run(s);

    expect(r.report.status).toBe('blocked');
    expect(r.report.uncertainties[0]).toContain('未调用 submit_report');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 无工具时走单次结构化输出（省 token）
// ═══════════════════════════════════════════════════════════

describe('⑤ 无工具时走单次路径', () => {
  it('不传 tools 时用 completeStructured，不跑循环', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    // 用一个只实现 completeStructured 的模型 —— 若走了循环会抛错
    const model: ModelPort = {
      describe: () => ({
    provider: 'x',
    model: 'y',
    capabilities: {
      supportsVision: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsThinking: true,
    },
  }),
      complete: async () => {
        throw new Error('不该走工具循环');
      },
      completeStructured: (async () => ({
        value: REPORT,
        usage: { inputTokens: 10, outputTokens: 5 },
        attempts: 1,
      })) as ModelPort['completeStructured'],
    };

    const r = await runServant({
      model,
      log,
      clock,
      servant: 'life',
      taskId: 's1',
      instruction: 'x',
      injectedConstraints: [],
      now: T0,
    });

    expect(r.report.status).toBe('done');
    expect(r.attempts).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 汇报工具自检
// ═══════════════════════════════════════════════════════════

describe('汇报工具自身', () => {
  it('是 readOnly 级（提交汇报无外部副作用）', () => {
    expect(submitReportTool().tier).toBe('readOnly');
  });

  it('extractReport 取最后一次成功提交', () => {
    const traces = [
      { toolName: 'submit_report', ok: false, args: { bad: true } },
      { toolName: 'submit_report', ok: true, args: { good: 1 } },
      { toolName: 'submit_report', ok: true, args: { good: 2 } },
    ];
    expect(extractReport(traces)).toEqual({ good: 2 });
  });

  it('没有成功提交时返回 undefined', () => {
    expect(extractReport([{ toolName: 'read_file', ok: true, args: {} }])).toBeUndefined();
    expect(extractReport([{ toolName: 'submit_report', ok: false, args: {} }])).toBeUndefined();
  });
});
