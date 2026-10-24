import { describe, expect, it } from 'vitest';

import {
  buildProcessView,
  describeTool,
  outcomeLabel,
  previewText,
  type ProcRound,
  type ProcTool,
} from '../processView.js';

function tool(overrides: Partial<ProcTool> & Pick<ProcTool, 'callId' | 'name'>): ProcTool {
  return {
    argsText: '{}',
    status: 'ok',
    output: '',
    durationMs: 120,
    ...overrides,
  };
}

function round(overrides: Partial<ProcRound> & Pick<ProcRound, 'round'>): ProcRound {
  return {
    reasoning: '',
    text: '',
    tools: [],
    ...overrides,
  };
}

describe('buildProcessView · 行与统计', () => {
  it('按轮次顺序摊平：思考 → 工具 → 输出', () => {
    const rounds: ProcRound[] = [
      round({
        round: 1,
        reasoning: '先看看冰箱里有什么。',
        text: '我先把文件读出来。',
        tools: [
          tool({
            callId: 'c1',
            name: 'read_file',
            argsText: '{"path":"冰箱盘点.txt"}',
          }),
        ],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.lines.map((l) => l.kind)).toEqual(['thinking', 'tool', 'text']);
    expect(view.stats.thinkingCount).toBe(1);
    expect(view.stats.toolCount).toBe(1);
  });

  it('思考次数只数“有思考内容”的轮次，不是轮次总数', () => {
    const rounds: ProcRound[] = [
      round({ round: 1, reasoning: '想一下。' }),
      round({ round: 2, reasoning: '   ' }),
      round({ round: 3, reasoning: '再想一下。' }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(rounds).toHaveLength(3);
    expect(view.stats.thinkingCount).toBe(2);
  });

  it('统计工具构成、被拒与失败次数', () => {
    const rounds: ProcRound[] = [
      round({
        round: 1,
        tools: [
          tool({ callId: 'a', name: 'read_file' }),
          tool({ callId: 'b', name: 'read_file' }),
          tool({ callId: 'c', name: 'run_command' }),
          tool({ callId: 'd', name: 'remove_path', status: 'denied' }),
          tool({ callId: 'e', name: 'write_file', status: 'error' }),
          tool({ callId: 'f', name: 'submit_report' }),
        ],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.stats.toolCount).toBe(6);
    expect(view.stats.denied).toBe(1);
    expect(view.stats.failed).toBe(1);
    expect(view.stats.composition).toEqual([
      { label: '读取', count: 2 },
      { label: '写入', count: 2 },
      { label: '运行', count: 1 },
      { label: '提交', count: 1 },
    ]);
  });

  it('完成后的 outcome 不出现“轮次/上限”字样（兼容旧数据）', () => {
    const finished = { rounds: 3, reason: 'roundLimit' };
    expect(outcomeLabel(finished, false)).toBe('执行未完成');
    expect(outcomeLabel(finished, false)).not.toMatch(/轮次|上限/);
    expect(outcomeLabel({ rounds: 1, reason: 'terminalTool' }, false)).toBe('提交结果');
    expect(outcomeLabel(null, true)).toBe('执行中');
  });
});

describe('describeTool · 人话标签', () => {
  it('读取文件显示目标路径', () => {
    const d = describeTool(
      tool({ callId: '1', name: 'read_file', argsText: '{"path":"冰箱盘点.txt"}' }),
    );
    expect(d).toMatchObject({ category: 'read', label: '读取', detail: '冰箱盘点.txt', icon: 'file' });
  });

  it('运行命令拼上参数数组', () => {
    const d = describeTool(
      tool({
        callId: '2',
        name: 'run_command',
        argsText: '{"command":"git","args":["status","--short"]}',
      }),
    );
    expect(d).toMatchObject({ category: 'run', label: '运行命令', detail: 'git status --short' });
  });

  it('提交结果取 reply 的首行', () => {
    const d = describeTool(
      tool({
        callId: '3',
        name: 'submit_report',
        argsText: '{"reply":"今晚可以做番茄炒蛋。\\n还有别的。"}',
      }),
    );
    expect(d).toMatchObject({ category: 'submit', label: '提交结果', detail: '今晚可以做番茄炒蛋。' });
  });

  it('未知工具不猜语义，原样显示', () => {
    const d = describeTool(tool({ callId: '4', name: 'mystery_tool', argsText: 'not-json' }));
    expect(d.label).toBe('mystery_tool');
    expect(d.category).toBe('other');
  });
});

describe('previewText', () => {
  it('折叠空白并截断', () => {
    expect(previewText('a\n\n  b   c')).toBe('a b c');
    expect(previewText('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
