import { describe, expect, it } from 'vitest';

import {
  actionForTool,
  actionLabelForTool,
  buildProcessView,
  describeTool,
  isHiddenProcessTool,
  isSubmissionOnlyRound,
  outcomeLabel,
  previewText,
  visibleProcessTools,
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

  it('统计工具构成、被拒与失败次数（提交工具不计数）', () => {
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
          tool({ callId: 'g', name: 'grep' }),
          tool({ callId: 'h', name: 'web_fetch' }),
          tool({ callId: 'i', name: 'desktop_screenshot' }),
          tool({ callId: 'j', name: 'mystery_tool' }),
        ],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.stats.toolCount).toBe(9);
    expect(view.stats.denied).toBe(1);
    expect(view.stats.failed).toBe(1);
    expect(view.stats.composition).toEqual([
      { label: '读取', count: 2 },
      { label: '编辑', count: 2 },
      { label: '执行', count: 1 },
      { label: '搜索', count: 1 },
      { label: '浏览', count: 1 },
      { label: '操作', count: 1 },
      { label: '工具', count: 1 },
    ]);
  });

  it('提交工具行不出现；提交轮次里的思考行也不出现，且不留空行', () => {
    const rounds: ProcRound[] = [
      round({
        round: 1,
        reasoning: '先读文件。',
        tools: [
          tool({ callId: 'r1', name: 'read_file' }),
          tool({ callId: 's1', name: 'submit_report' }),
        ],
      }),
      round({
        round: 2,
        reasoning: '材料齐了，现在提交报告。',
        tools: [tool({ callId: 's2', name: 'submit_report' })],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.lines.map((l) => l.kind)).toEqual(['thinking', 'tool']);
    expect(view.stats.thinkingCount).toBe(1);
    expect(view.stats.toolCount).toBe(1);
    expect(
      view.lines.some((line) => line.kind === 'tool' && line.tool.name === 'submit_report'),
    ).toBe(false);
    expect(view.lines.some((line) => line.kind === 'thinking' && line.text.includes('提交报告'))).toBe(
      false,
    );
  });

  it('提交轮次仍有正文时保留正文，只隐藏提交工具与提交思考', () => {
    const rounds: ProcRound[] = [
      round({
        round: 1,
        reasoning: '现在提交。',
        text: '已经从冰箱里找到三样食材。',
        tools: [tool({ callId: 's1', name: 'submit_report' })],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.lines.map((l) => l.kind)).toEqual(['text']);
    expect(view.stats.thinkingCount).toBe(0);
    expect(view.stats.toolCount).toBe(0);
  });

  it('完成后的 outcome 不出现“轮次/上限”字样（兼容旧数据）', () => {
    const finished = { rounds: 3, reason: 'roundLimit' };
    expect(outcomeLabel(finished, false)).toBe('执行未完成');
    expect(outcomeLabel(finished, false)).not.toMatch(/轮次|上限/);
    expect(outcomeLabel({ rounds: 1, reason: 'terminalTool' }, false)).toBe('提交结果');
    expect(outcomeLabel(null, true)).toBe('执行中');
  });
});

describe('动作映射 · 主对话与审查共用', () => {
  it('按用户确认的表格把工具名映射成动作标签', () => {
    const cases: readonly [string, string][] = [
      ['read_file', '读取'],
      ['list_dir', '读取'],
      ['stat_path', '读取'],
      ['write_file', '编辑'],
      ['file_op', '编辑'],
      ['make_dir', '编辑'],
      ['move_path', '编辑'],
      ['remove_path', '编辑'],
      ['apply_patch', '编辑'],
      ['run_command', '执行'],
      ['grep', '搜索'],
      ['glob', '搜索'],
      ['script_search', '搜索'],
      ['document_search', '搜索'],
      ['web_search', '搜索'],
      ['web_fetch', '浏览'],
      ['desktop_observe', '操作'],
      ['desktop_act', '操作'],
      // 收敛前的旧名字：历史 trace 仍要按同一套动作显示。
      ['desktop_list_windows', '操作'],
      ['desktop_uia_read', '操作'],
      ['desktop_uia_invoke', '操作'],
      ['desktop_uia_set_value', '操作'],
      ['desktop_screenshot', '操作'],
      ['desktop_wait_for', '操作'],
      ['desktop_office_convert', '操作'],
      ['desktop_experience', '操作'],
      ['mystery_tool', '工具'],
      ['mcp__filesystem__read_file', '工具'],
    ];

    for (const [name, label] of cases) {
      expect(actionLabelForTool(name), name).toBe(label);
    }
  });

  it('收敛后的新入口与旧名字在统计里归并到同一动作', () => {
    const rounds: ProcRound[] = [
      round({
        round: 1,
        tools: [
          tool({ callId: 'a', name: 'file_op', argsText: '{"action":"mkdir","path":"docs/new"}' }),
          tool({ callId: 'b', name: 'make_dir', argsText: '{"path":"docs/old"}' }),
          tool({ callId: 'c', name: 'desktop_observe', argsText: '{"action":"list_windows"}' }),
          tool({ callId: 'd', name: 'desktop_act', argsText: '{"action":"invoke"}' }),
          tool({ callId: 'e', name: 'desktop_screenshot', argsText: '{"path":"shot.png"}' }),
          tool({ callId: 'f', name: 'submit_report' }),
        ],
      }),
    ];

    const view = buildProcessView({ rounds, finished: null, durationMs: null });

    expect(view.stats.toolCount).toBe(5);
    expect(view.stats.composition).toEqual([
      { label: '编辑', count: 2 },
      { label: '操作', count: 3 },
    ]);
  });

  it('提交工具被明确标记为隐藏', () => {
    expect(isHiddenProcessTool('submit_report')).toBe(true);
    expect(isHiddenProcessTool('submit_review')).toBe(true);
    expect(isHiddenProcessTool('read_file')).toBe(false);
  });

  it('过滤提交工具时保留其余工具的顺序', () => {
    const tools = [
      tool({ callId: '1', name: 'read_file' }),
      tool({ callId: '2', name: 'submit_review' }),
      tool({ callId: '3', name: 'web_search' }),
    ];
    expect(visibleProcessTools(tools).map((t) => t.name)).toEqual(['read_file', 'web_search']);
  });

  it('只有提交调用的轮次可被整轮判定为不可见', () => {
    const submit = tool({ callId: 's', name: 'submit_report' });
    expect(isSubmissionOnlyRound({ reasoning: '提交。', text: '', tools: [submit] })).toBe(true);
    expect(isSubmissionOnlyRound({ reasoning: '', text: '正文', tools: [submit] })).toBe(true);
    expect(
      isSubmissionOnlyRound({
        reasoning: '提交。',
        text: '',
        tools: [submit, tool({ callId: 'r', name: 'read_file' })],
      }),
    ).toBe(false);
    expect(isSubmissionOnlyRound({ reasoning: '想想。', text: '', tools: [] })).toBe(false);
  });

  it('未知工具落到 tool，不猜语义', () => {
    expect(actionForTool('mystery_tool')).toBe('tool');
    expect(actionForTool('mcp__foo__bar')).toBe('tool');
    expect(actionForTool('desktop_experience')).toBe('operate');
  });
});

describe('describeTool · 动作标签与详情', () => {
  it('读取文件显示动作与目标路径', () => {
    const d = describeTool(
      tool({ callId: '1', name: 'read_file', argsText: '{"path":"冰箱盘点.txt"}' }),
    );
    expect(d).toMatchObject({
      action: 'read',
      label: '读取',
      detail: '冰箱盘点.txt',
      icon: 'file',
    });
  });

  it('列目录也归入读取，不再单独写“浏览”', () => {
    const d = describeTool(tool({ callId: '2', name: 'list_dir', argsText: '{"path":"docs"}' }));
    expect(d).toMatchObject({ action: 'read', label: '读取', detail: 'docs' });
  });

  it('运行命令拼上参数数组', () => {
    const d = describeTool(
      tool({
        callId: '3',
        name: 'run_command',
        argsText: '{"command":"git","args":["status","--short"]}',
      }),
    );
    expect(d).toMatchObject({ action: 'exec', label: '执行', detail: 'git status --short' });
  });

  it('精确改文本归入编辑并保留文件路径', () => {
    const d = describeTool(
      tool({
        callId: '4',
        name: 'apply_patch',
        argsText: '{"path":"src/app/page.tsx","oldText":"a","newText":"b"}',
      }),
    );
    expect(d).toMatchObject({ action: 'edit', label: '编辑', detail: 'src/app/page.tsx' });
  });

  it('搜索类工具归入搜索，详情保留查询与范围', () => {
    expect(
      describeTool(
        tool({
          callId: '5',
          name: 'grep',
          argsText: '{"query":"TODO","path":"src","glob":"**/*.ts"}',
        }),
      ),
    ).toMatchObject({ action: 'search', label: '搜索', detail: 'TODO · src · **/*.ts' });

    expect(
      describeTool(
        tool({ callId: '6', name: 'glob', argsText: '{"pattern":"**/*.md","path":"docs"}' }),
      ),
    ).toMatchObject({ action: 'search', label: '搜索', detail: '**/*.md · docs' });

    expect(
      describeTool(
        tool({ callId: '7', name: 'document_search', argsText: '{"query":"冰箱"}' }),
      ),
    ).toMatchObject({ action: 'search', label: '搜索', detail: '冰箱' });

    expect(
      describeTool(tool({ callId: '8', name: 'web_search', argsText: '{"query":"天气预报"}' })),
    ).toMatchObject({ action: 'search', label: '搜索', detail: '天气预报' });
  });

  it('抓网页归入浏览', () => {
    const d = describeTool(
      tool({ callId: '9', name: 'web_fetch', argsText: '{"url":"https://example.com/a"}' }),
    );
    expect(d).toMatchObject({
      action: 'browse',
      label: '浏览',
      detail: 'https://example.com/a',
      icon: 'eye',
    });
  });

  it('桌面工具归入操作，详情取路径/名称/窗口', () => {
    const d = describeTool(
      tool({
        callId: '10',
        name: 'desktop_screenshot',
        argsText: '{"path":"C:\\\\tmp\\\\shot.png"}',
      }),
    );
    expect(d).toMatchObject({ action: 'operate', label: '操作', detail: 'C:\\tmp\\shot.png' });
  });

  it('file_op 按 action 显示路径或 from → to', () => {
    expect(
      describeTool(
        tool({
          callId: '12a',
          name: 'file_op',
          argsText: '{"action":"mkdir","path":"docs/new"}',
        }),
      ),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'docs/new', icon: 'upload' });

    expect(
      describeTool(
        tool({
          callId: '12b',
          name: 'file_op',
          argsText: '{"action":"move","from":"a.txt","to":"b.txt"}',
        }),
      ),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'a.txt → b.txt', icon: 'upload' });

    expect(
      describeTool(
        tool({
          callId: '12c',
          name: 'file_op',
          argsText: '{"action":"remove","path":"tmp/a.log"}',
        }),
      ),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'tmp/a.log', icon: 'upload' });
  });

  it('旧文件工具名仍是编辑（make_dir / move_path / remove_path）', () => {
    expect(
      describeTool(tool({ callId: '13a', name: 'make_dir', argsText: '{"path":"docs/x"}' })),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'docs/x' });
    expect(
      describeTool(tool({ callId: '13b', name: 'move_path', argsText: '{"from":"a","to":"b"}' })),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'a → b' });
    expect(
      describeTool(tool({ callId: '13c', name: 'remove_path', argsText: '{"path":"c"}' })),
    ).toMatchObject({ action: 'edit', label: '编辑', detail: 'c' });
  });

  it('desktop_observe 按 action 显示窗口或截图路径', () => {
    expect(
      describeTool(
        tool({
          callId: '14a',
          name: 'desktop_observe',
          argsText: '{"action":"screenshot","path":"C:\\\\tmp\\\\shot.png"}',
        }),
      ),
    ).toMatchObject({
      action: 'operate',
      label: '操作',
      detail: 'C:\\tmp\\shot.png',
      icon: 'eye',
    });

    expect(
      describeTool(
        tool({ callId: '14b', name: 'desktop_observe', argsText: '{"action":"read_ui","window":"记事本"}' }),
      ),
    ).toMatchObject({ action: 'operate', label: '操作', detail: '记事本', icon: 'eye' });

    expect(
      describeTool(
        tool({ callId: '14c', name: 'desktop_observe', argsText: '{"action":"list_windows"}' }),
      ),
    ).toMatchObject({ action: 'operate', label: '操作', detail: '' });
  });

  it('desktop_act 显示窗口/控件，Office 转换显示 source → target', () => {
    expect(
      describeTool(
        tool({
          callId: '15a',
          name: 'desktop_act',
          argsText: '{"action":"set_value","window":"记事本","name":"文本编辑器"}',
        }),
      ),
    ).toMatchObject({
      action: 'operate',
      label: '操作',
      detail: '记事本 · 文本编辑器',
      icon: 'external',
    });

    expect(
      describeTool(
        tool({
          callId: '15b',
          name: 'desktop_act',
          argsText: '{"action":"convert_office","source":"a.docx","target":"a.pdf"}',
        }),
      ),
    ).toMatchObject({ action: 'operate', label: '操作', detail: 'a.docx → a.pdf' });
  });

  it('旧桌面工具名仍显示路径 / 名称 / 窗口，不落到未知', () => {
    expect(
      describeTool(
        tool({
          callId: '16a',
          name: 'desktop_uia_invoke',
          argsText: '{"window":"记事本","name":"保存"}',
        }),
      ),
    ).toMatchObject({ action: 'operate', label: '操作', detail: '保存' });

    expect(
      describeTool(
        tool({ callId: '16b', name: 'desktop_wait_for', argsText: '{"window":"记事本"}' }),
      ),
    ).toMatchObject({ action: 'operate', label: '操作', detail: '记事本' });

    expect(
      describeTool(tool({ callId: '16c', name: 'desktop_office_convert', argsText: '{}' })),
    ).toMatchObject({ action: 'operate', label: '操作', detail: '' });
  });

  it('折叠行的 label 只有动作，不带原始工具名', () => {
    for (const [name, label] of [
      ['file_op', '编辑'],
      ['desktop_observe', '操作'],
      ['desktop_act', '操作'],
    ] as const) {
      const d = describeTool(tool({ callId: `17-${name}`, name, argsText: '{}' }));
      expect(d.label).toBe(label);
      expect(d.label).not.toMatch(/file_op|desktop/);
    }
  });

  it('未知/MCP 工具只显示“工具”，折叠行不带原始工具名', () => {
    const d = describeTool(tool({ callId: '11', name: 'mcp__foo__bar', argsText: '{"x":1}' }));
    expect(d).toMatchObject({ action: 'tool', label: '工具', detail: '', icon: 'sparkle' });
    expect(d.label).not.toMatch(/mcp|其他|未知/);
  });
});

describe('previewText', () => {
  it('折叠空白并截断', () => {
    expect(previewText('a\n\n  b   c')).toBe('a b c');
    expect(previewText('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
