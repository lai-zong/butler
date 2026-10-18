/**
 * 桌面工具验证（v8 · 方案 §9）
 *
 * ★ 用**假桥**测工具逻辑 —— 不依赖 Python、不依赖本机装没装 Office。
 *   真实 COM/UIA 的验证在 `validate:15`（它会真的跑一次 Word→PDF）。
 *
 * ★★ 这里要钉死的四件事，都是"权限与降级"层面的：
 *   ① 三个工具的 **tier** 与方案 §9.4 的分层一致
 *   ② 能力探测决定**注册哪些**工具（缺模块就不注册，而不是注册了再失败）
 *   ③ 参数校验在**执行前**就挡住明显错误的调用
 *   ④ 工具失败时**如实返回原因**，不把异常吞成"成功"
 */

import { describe, expect, it, vi } from 'vitest';

import { desktopTools } from '../builtin/desktop.js';
import type { DesktopBridgePort } from '../../desktop/port.js';
import type { OperationMemoryStore } from '../../memory/operations.js';

/** 假桥：记录调用，按需返回或抛错 */
function fakeBridge(over: Partial<DesktopBridgePort> = {}): DesktopBridgePort {
  return {
    ping: vi.fn(async () => ({ python: '3.12', platform: 'win32', capabilities: {} })),
    listWindows: vi.fn(async () => [
      { title: '记事本', className: 'Notepad', processId: 100 },
      { title: 'Word', className: 'OpusApp', processId: 200 },
    ]),
    officeConvert: vi.fn(async (source: string, target: string) => ({
      source,
      target,
      bytes: 1234,
    })),
    screenshot: vi.fn(async () => ({ path: 'C:/tmp/shot.png', backend: 'mss', width: 1920, height: 1080 })),
    uiaTree: vi.fn(async () => ({
      nodes: [
        { depth: 0, type: 'WindowControl', name: '设置', automationId: '', className: 'App', rect: [0, 0, 100, 100] as const },
        { depth: 1, type: 'ButtonControl', name: '确定', automationId: 'ok', className: '', rect: [10, 10, 20, 20] as const },
      ],
      truncated: false,
      limits: { depth: 8, max: 200 },
    })),
    uiaFind: vi.fn(async () => ({
      count: 1,
      matches: [
        {
          type: 'ButtonControl',
          name: '确定',
          automationId: 'ok',
          rect: [10, 10, 20, 20] as const,
          patterns: ['Invoke'],
        },
      ],
    })),
    uiaAction: vi.fn(async () => ({
      action: 'toggle',
      control: { type: 'ButtonControl', name: '开关', automationId: 'sw', rect: [0, 0, 10, 10] as const },
      before: 0,
      after: 1,
      verified: true,
    })),
    uiaSetValue: vi.fn(async () => ({
      control: { type: 'EditControl', name: '搜索', automationId: 'se', rect: [0, 0, 10, 10] as const },
      before: '',
      after: '显示',
      verified: true,
    })),
    foregroundWindow: vi.fn(async () => ({ app: 'Code.exe', hadInput: true, idleMs: 1000 })),
    close: vi.fn(),
    ...over,
  };
}

/** 全部能力可用 */
const ALL_CAPS = { win32com: true, uiautomation: true, mss: true, PIL: true, pyautogui: true };

describe('desktopTools —— 能力探测决定注册哪些工具', () => {
  it('能力齐全 → 七个工具都在', () => {
    const specs = desktopTools(fakeBridge(), ALL_CAPS);
    expect(specs.map((s) => s.name).sort()).toEqual([
      'desktop_list_windows',
      'desktop_office_convert',
      'desktop_screenshot',
      'desktop_uia_invoke',
      'desktop_uia_read',
      'desktop_uia_set_value',
      'desktop_wait_for',
    ]);
  });

  it('★ 缺 uiautomation → 四个 UIA 工具全不注册', () => {
    const specs = desktopTools(fakeBridge(), { ...ALL_CAPS, uiautomation: false });
    const names = specs.map((s) => s.name);
    expect(names).not.toContain('desktop_list_windows');
    expect(names).not.toContain('desktop_uia_read');
    expect(names).not.toContain('desktop_uia_invoke');
    expect(names).not.toContain('desktop_uia_set_value');
  });

  it('★ 缺 win32com → 不注册 Office 转换（而不是注册了再失败）', () => {
    const specs = desktopTools(fakeBridge(), { ...ALL_CAPS, win32com: false });
    expect(specs.map((s) => s.name)).not.toContain('desktop_office_convert');
  });

  it('★ 缺 uiautomation → 不注册列窗口', () => {
    const specs = desktopTools(fakeBridge(), { ...ALL_CAPS, uiautomation: false });
    expect(specs.map((s) => s.name)).not.toContain('desktop_list_windows');
  });

  it('★ mss 与 PIL 都缺 → 不注册截图', () => {
    const specs = desktopTools(fakeBridge(), { ...ALL_CAPS, mss: false, PIL: false });
    expect(specs.map((s) => s.name)).not.toContain('desktop_screenshot');
  });

  it('mss 缺但 PIL 在 → 仍然注册截图（PIL 是降级后端）', () => {
    const specs = desktopTools(fakeBridge(), { ...ALL_CAPS, mss: false });
    expect(specs.map((s) => s.name)).toContain('desktop_screenshot');
  });

  it('全部缺失 → 返回空数组（桌面能力不可用，但系统照常）', () => {
    expect(desktopTools(fakeBridge(), {})).toHaveLength(0);
  });
});

describe('desktopTools —— 权限分级与方案 §9.4 一致', () => {
  const specs = desktopTools(fakeBridge(), ALL_CAPS);
  const byName = (n: string) => specs.find((s) => s.name === n);

  it('★ COM（应用接口）→ normal（需确认的写操作）', () => {
    expect(byName('desktop_office_convert')?.tier).toBe('normal');
  });

  it('★ UIA 只读操作 → readOnly', () => {
    expect(byName('desktop_list_windows')?.tier).toBe('readOnly');
    expect(byName('desktop_uia_read')?.tier).toBe('readOnly');
  });

  it('★★ UIA 写操作 → highRisk（会改变应用状态）', () => {
    expect(byName('desktop_uia_invoke')?.tier).toBe('highRisk');
    expect(byName('desktop_uia_set_value')?.tier).toBe('highRisk');
  });

  it('★★ 截图 → highRisk，不是 readOnly', () => {
    /**
     * ⚠️ 这条是刻意的：截图**不改变**系统状态，但它**读取了用户屏幕上的一切**
     *    （聊天记录、密码框、私人照片）。按 readOnly 自动放行
     *    等于让模型随时偷看屏幕 —— 那不该是默认行为。
     */
    expect(byName('desktop_screenshot')?.tier).toBe('highRisk');
    expect(byName('desktop_screenshot')?.tier).not.toBe('readOnly');
  });

  it('★ 没有 click / type（等 C6 询问开关落地再接）', () => {
    /**
     * 理由：点击/输入到指定坐标是不可逆的视觉层操作，需要"每次确认"。
     * 而现在注册成 `dangerous` 就是**永远禁用**（策略对 dangerous 恒 false），
     * 注册了也用不了 —— 那只会制造"有这个能力"的错觉。
     *
     * ★ 注意区分：`desktop_uia_invoke` 不是坐标点击，它是**按元素**操作，
     *   且带状态校验 —— 属于 ② UIA 层，不是 ③ 视觉层。
     */
    expect(byName('desktop_click')).toBeUndefined();
    expect(byName('desktop_click_at')).toBeUndefined();
    expect(byName('desktop_type')).toBeUndefined();
  });

  it('高危工具提供 preview（用户得能看到"会动到什么"）', () => {
    const shot = byName('desktop_screenshot');
    expect(typeof shot?.preview).toBe('function');
    const conv = byName('desktop_office_convert');
    expect(typeof conv?.preview).toBe('function');
    expect(typeof byName('desktop_uia_invoke')?.preview).toBe('function');
    expect(typeof byName('desktop_uia_set_value')?.preview).toBe('function');
  });
});

describe('desktop_wait_for —— 等到界面就绪', () => {
  it('控件立刻就在 → 马上返回，不白等', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_wait_for');
    if (!tool) throw new Error('工具缺失');

    const t0 = Date.now();
    const r = await tool.execute({ window: '设置', name: '确定' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('已出现');
    // 已经存在时不该睡一个轮询周期以上
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('★ 窗口还没出现 → 轮询直到出现（不是一次就放弃）', async () => {
    let calls = 0;
    const bridge = fakeBridge({
      uiaFind: vi.fn(async () => {
        calls++;
        // 前 2 次找不到，第 3 次出现
        if (calls < 3) throw new Error('找不到窗口（还没就绪）');
        return {
          count: 1,
          matches: [{ type: 'ButtonControl', name: '确定', automationId: 'ok', rect: [0, 0, 1, 1] as const }],
        };
      }),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_wait_for');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute(
      { window: '设置', name: '确定', pollMs: 100, timeoutMs: 5000 },
      {} as never,
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('★★ 超时 → 返回失败并说明最后一次原因', async () => {
    const bridge = fakeBridge({
      uiaFind: vi.fn(async () => {
        throw new Error('找不到窗口');
      }),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_wait_for');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute(
      { window: '不存在', name: 'X', pollMs: 100, timeoutMs: 600 },
      {} as never,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain('超时');
    expect(r.output).toContain('找不到窗口');
  });

  it('不给 name → 只等窗口出现', async () => {
    const bridge = fakeBridge({
      listWindows: vi.fn(async () => [{ title: '酷狗音乐', className: 'kugou_ui', processId: 1 }]),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_wait_for');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '酷狗', timeoutMs: 2000 }, {} as never);
    expect(r.ok).toBe(true);
    expect(bridge.uiaFind).not.toHaveBeenCalled();
  });

  it('timeoutMs / pollMs 有上下限保护', async () => {
    // 传负数不应导致死循环或立即失败
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_wait_for');
    if (!tool) throw new Error('工具缺失');
    const r = await tool.execute({ window: '设置', name: '确定', timeoutMs: -1, pollMs: 0 }, {} as never);
    expect(r.ok).toBe(true);
  });
});

describe('desktop_uia_read —— 截断必须说出来', () => {
  it('★★ 被截断时明确告知"这棵树不完整"', async () => {
    const bridge = fakeBridge({
      uiaTree: vi.fn(async () => ({
        nodes: [
          { depth: 0, type: 'WindowControl', name: 'W', automationId: '', className: '', rect: [0, 0, 1, 1] as const },
        ],
        truncated: true,
        limits: { depth: 8, max: 200 },
      })),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: 'W' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('已截断');
    // 必须提醒"不要据此断言没有该控件"
    expect(r.output).toContain('不完整');
  });

  it('未截断时不出现截断警告', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');
    const r = await tool.execute({ window: '设置' }, {} as never);
    expect(r.output).not.toContain('已截断');
  });
});

describe('★ 阶梯级（D-32）：能不动鼠标键盘就不动', () => {
  const specs = desktopTools(fakeBridge(), ALL_CAPS);
  const byName = (n: string) => specs.find((s) => s.name === n);

  it('COM 转换 = 第 1 级', () => {
    expect(byName('desktop_office_convert')?.rung).toBe(1);
  });

  it('★ UIA 模式调用 = 第 2 级（不碰鼠标键盘）', () => {
    expect(byName('desktop_uia_invoke')?.rung).toBe(2);
    expect(byName('desktop_uia_set_value')?.rung).toBe(2);
  });

  it('★★ 当前**没有**第 3 / 第 4 级工具（不制造"有这个能力"的错觉）', () => {
    /**
     * 第 3 级（窗口消息）与第 4 级（真实注入）都还没实现。
     * 这不是遗漏，是刻意的：第 4 级需要 C8 询问通道才能做到"每次确认"，
     * 而 C8 还没建。先注册成 highRisk 会绕过"每次确认"的承诺。
     */
    expect(specs.every((s) => s.rung === undefined || s.rung === 1 || s.rung === 2)).toBe(true);
  });

  it('★ 读类工具不标阶梯级（阶梯只描述"动手"的手段）', () => {
    expect(byName('desktop_uia_read')?.rung).toBeUndefined();
    expect(byName('desktop_list_windows')?.rung).toBeUndefined();
    expect(byName('desktop_wait_for')?.rung).toBeUndefined();
    expect(byName('desktop_screenshot')?.rung).toBeUndefined();
  });
});

/** 假的操作记忆仓储：只记录调用，不实现真实逻辑 */
function fakeOps(over: Partial<OperationMemoryStore> = {}): OperationMemoryStore {
  const calls: Array<Record<string, unknown>> = [];
  const store = {
    recordAttempt: vi.fn((args: Record<string, unknown>) => {
      calls.push(args);
      return {
        id: 'op_1',
        userId: 'local',
        kind: 'method',
        taskSignature: 'convert|word|',
        content: '',
        createdAt: 0,
        updatedAt: 0,
        effectiveness: { attempts: 1, succeeded: 1, lastUsedAt: 0, avgDurationMs: 0 },
      };
    }),
    recommend: vi.fn(() => ({
      taskSignature: 'convert|word|',
      ranked: [],
      discouraged: [],
      usedMemory: false,
    })),
    ...over,
  } as unknown as OperationMemoryStore;
  (store as unknown as { __calls: typeof calls }).__calls = calls;
  return store;
}

describe('★ 操作记忆接线（方案 §6.3 ① 方法记忆）', () => {
  it('给了仓储 → 会多出一个 desktop_experience 工具', () => {
    const specs = desktopTools(fakeBridge(), ALL_CAPS, fakeOps());
    expect(specs.map((s) => s.name)).toContain('desktop_experience');
  });

  it('不给仓储 → 行为与之前完全一致（记忆是旁路，不是依赖）', () => {
    const specs = desktopTools(fakeBridge(), ALL_CAPS);
    expect(specs.map((s) => s.name)).not.toContain('desktop_experience');
  });

  it('★★ 成功动作按 task 记录（阶梯级 1 → api）', async () => {
    const ops = fakeOps();
    const specs = desktopTools(fakeBridge(), ALL_CAPS, ops);
    const tool = specs.find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await tool.execute(
      { source: 'a.docx', target: 'b.pdf' },
      { task: '把一批 Word 转成 PDF', clock: {} as never, taskId: 't1' } as never,
    );

    const calls = (ops as unknown as { __calls: Array<Record<string, unknown>> }).__calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.['task']).toBe('把一批 Word 转成 PDF');
    expect(calls[0]?.['path']).toBe('api');
    expect(calls[0]?.['success']).toBe(true);
  });

  it('★★ 失败动作也记录，并带上失败原因', async () => {
    const bridge = fakeBridge({
      officeConvert: vi.fn(async () => {
        throw new Error('源文件不存在');
      }),
    });
    const ops = fakeOps();
    const tool = desktopTools(bridge, ALL_CAPS, ops).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await expect(
      tool.execute({ source: 'x.docx', target: 'y.pdf' }, { task: '转换文档', clock: {} as never, taskId: 't' } as never),
    ).rejects.toThrow(/源文件不存在/);

    const calls = (ops as unknown as { __calls: Array<Record<string, unknown>> }).__calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.['success']).toBe(false);
    expect(String(calls[0]?.['failureReason'])).toContain('源文件不存在');
  });

  it('★ ctx.task 缺失 → 不记录（没有签名就别污染记忆）', async () => {
    const ops = fakeOps();
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await tool.execute({ source: 'a.docx', target: 'b.pdf' }, { clock: {} as never, taskId: 't' } as never);
    const calls = (ops as unknown as { __calls: unknown[] }).__calls;
    expect(calls).toHaveLength(0);
  });

  it('★★★ 记忆写入抛错**不能**影响工具结果（旁路原则）', async () => {
    const ops = fakeOps({
      recordAttempt: vi.fn(() => {
        throw new Error('记忆库炸了');
      }) as never,
    });
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    // 记忆写入失败，但工具本身必须照常成功
    const r = await tool.execute(
      { source: 'a.docx', target: 'b.pdf' },
      { task: '转换', clock: {} as never, taskId: 't' } as never,
    );
    expect(r.ok).toBe(true);
  });

  it('★★ office_convert 的 app 记成 office，不是文件扩展名', async () => {
    /**
     * ⚠️ 参数里只有文件路径。若从扩展名推 app，会得到一个叫 `docx` 的**假应用**，
     *    应用级聚合就被污染了。这条断言钉住 `actionApp: 'office'`。
     */
    const ops = fakeOps();
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await tool.execute(
      { source: 'C:/x/a.docx', target: 'C:/x/b.pdf' },
      { task: '转换文档', clock: {} as never, taskId: 't' } as never,
    );
    const calls = (ops as unknown as { __calls: Array<Record<string, unknown>> }).__calls;
    expect(calls[0]?.['app']).toBe('office');
    expect(calls[0]?.['app']).not.toBe('docx');
  });

  it('★ UIA 模式调用记成 uia 路径（阶梯 2）', async () => {    const ops = fakeOps();
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    await tool.execute(
      { window: '设置', name: '开关', action: 'toggle' },
      { task: '打开动态光效', clock: {} as never, taskId: 't' } as never,
    );

    const calls = (ops as unknown as { __calls: Array<Record<string, unknown>> }).__calls;
    expect(calls[0]?.['path']).toBe('uia');
    // app 从 window 参数推出来
    expect(calls[0]?.['app']).toBe('设置');
  });

  it('读类工具不记录（阶梯只描述"动手"）', async () => {
    const ops = fakeOps();
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');

    await tool.execute({ window: '设置', name: '确定' }, { task: '看看界面', clock: {} as never, taskId: 't' } as never);
    const calls = (ops as unknown as { __calls: unknown[] }).__calls;
    expect(calls).toHaveLength(0);
  });
});

describe('desktop_experience —— 查历史经验', () => {
  it('没有历史 → 明说"还没有记录"，并给出默认顺序', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS, fakeOps()).find((s) => s.name === 'desktop_experience');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ task: '把 Word 转 PDF' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('还没有历史记录');
    expect(r.output).toContain('应用接口');
  });

  it('有历史 → 列出路径成功率与"已知不可行"', async () => {
    const ops = fakeOps({
      recommend: vi.fn(() => ({
        taskSignature: 'convert|word|',
        ranked: [
          { path: 'api' as const, score: 0.9, why: '5 次成功 5 次', fromExperience: true },
          { path: 'uia' as const, score: 0.2, why: '2 次失败', fromExperience: true, adviseGivingUp: true },
        ],
        discouraged: ['uia' as const],
        stale: [],
        usedMemory: true,
      })) as never,
    });
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_experience');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ task: '把 Word 转 PDF' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('实测');
    expect(r.output).toContain('已知不可行');
    expect(r.output).toContain('建议放弃');
  });

  it('★★ 过期经验也照实提示（但仍留在列表里）', async () => {
    const ops = fakeOps({
      recommend: vi.fn(() => ({
        taskSignature: 'toggle|switch|设置',
        ranked: [
          {
            path: 'uia' as const,
            score: 0.3,
            why: '历史记录：尝试 2 次、成功 0 次',
            fromExperience: true,
            stale: true,
          },
        ],
        discouraged: [],
        stale: ['uia' as const],
        usedMemory: true,
      })) as never,
    });
    const tool = desktopTools(fakeBridge(), ALL_CAPS, ops).find((s) => s.name === 'desktop_experience');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ task: '打开动态光效' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('可能已过期');
    expect(r.output).toContain('用之前必须先验证');
    // 关键：仍然出现在列表里，而不是被删掉
    expect(r.output).toContain('无障碍接口 UIA');
  });
});
describe('desktop_uia_read —— 查找与结构', () => {
  it('给 name → 报告匹配数与可用模式', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '设置', name: '确定' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('共 1 个匹配');
    expect(r.output).toContain('Invoke');
  });

  it('不给 name → 导出控件树（带缩进层级）', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '设置' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('控件树（2 个）');
    expect(r.output).toContain('  [ButtonControl] 确定');
  });

  it('缺 window → 拒绝', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/window/);
  });

  it('depth/max 有上限保护', async () => {
    const bridge = fakeBridge();
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_read');
    if (!tool) throw new Error('工具缺失');

    await tool.execute({ window: '设置', depth: 999, max: 9999 }, {} as never);
    expect(bridge.uiaTree).toHaveBeenCalledWith('设置', 12, 500);
  });
});

describe('desktop_uia_invoke', () => {
  it('toggle 成功：报告 before → after', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute(
      { window: '设置', name: '在我的设备上使用动态光效', action: 'toggle', controlType: 'button' },
      {} as never,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('0 → 1');
  });

  it('★★ verified=false → 返回失败，而不是"操作成功"', async () => {
    /**
     * 这是这个工具最重要的性质：**状态没变就是失败**。
     * 报成成功会让模型以为改好了，然后基于错误前提继续干活。
     */
    const bridge = fakeBridge({
      uiaAction: vi.fn(async () => ({
        action: 'toggle',
        control: { type: 'ButtonControl', name: '开关', automationId: 'sw', rect: [0, 0, 10, 10] as const },
        before: 0,
        after: 0,
        verified: false,
      })),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: 'W', name: '开关', action: 'toggle' }, {} as never);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('未生效');
  });

  it('无状态可比对（invoke）→ verified=null，仍算成功', async () => {
    const bridge = fakeBridge({
      uiaAction: vi.fn(async () => ({
        action: 'invoke',
        control: { type: 'ButtonControl', name: '个性化', automationId: '', rect: [0, 0, 10, 10] as const },
        before: null,
        after: null,
        verified: null,
      })),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '设置', name: '个性化', action: 'invoke' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('没有可读回的状态');
  });

  it('★ 非法 action → 执行前拒绝，且不调桥', async () => {
    const bridge = fakeBridge();
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    await expect(
      tool.execute({ window: 'W', name: 'N', action: '双击' }, {} as never),
    ).rejects.toThrow(/action/);
    expect(bridge.uiaAction).not.toHaveBeenCalled();
  });

  it('★★ 桥报"多个匹配"时，错误如实传出（不吞成成功）', async () => {
    const bridge = fakeBridge({
      uiaAction: vi.fn(async () => {
        throw new Error('有 3 个互不嵌套的控件都支持InvokePattern，拒绝猜测');
      }),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_invoke');
    if (!tool) throw new Error('工具缺失');

    await expect(
      tool.execute({ window: 'W', name: 'N', action: 'invoke' }, {} as never),
    ).rejects.toThrow(/拒绝猜测/);
  });
});

describe('desktop_uia_set_value', () => {
  it('写入成功：报告前值 → 现值', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_uia_set_value');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '设置', name: '搜索框', value: '显示' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('「显示」');
  });

  it('★ verified=false → 返回失败并给出实际值', async () => {
    const bridge = fakeBridge({
      uiaSetValue: vi.fn(async () => ({
        control: { type: 'EditControl', name: '搜索', automationId: '', rect: [0, 0, 1, 1] as const },
        before: '',
        after: '',
        verified: false,
      })),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_uia_set_value');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ window: '设置', name: '搜索', value: '显示' }, {} as never);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('未生效');
  });
});

describe('desktop_list_windows', () => {
  it('把窗口渲染成可读文本', async () => {
    const specs = desktopTools(fakeBridge(), ALL_CAPS);
    const tool = specs.find((s) => s.name === 'desktop_list_windows');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({}, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('记事本');
    expect(r.output).toContain('pid 100');
  });

  it('limit 有上限保护（不让模型一次拉一万个窗口）', async () => {
    const bridge = fakeBridge();
    const specs = desktopTools(bridge, ALL_CAPS);
    const tool = specs.find((s) => s.name === 'desktop_list_windows');
    if (!tool) throw new Error('工具缺失');

    await tool.execute({ limit: 99999 }, {} as never);
    expect(bridge.listWindows).toHaveBeenCalledWith(200);
  });

  it('空窗口列表 → 给一句明确的话，而不是空字符串', async () => {
    const bridge = fakeBridge({ listWindows: vi.fn(async () => []) });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_list_windows');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({}, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
  });
});

describe('desktop_office_convert', () => {
  it('正常转换：返回字节数', async () => {
    const specs = desktopTools(fakeBridge(), ALL_CAPS);
    const tool = specs.find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({ source: 'a.docx', target: 'b.pdf' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1234');
  });

  it('★ target 不是 .pdf → 执行前就拒绝', async () => {
    const bridge = fakeBridge();
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await expect(
      tool.execute({ source: 'a.docx', target: 'b.docx' }, {} as never),
    ).rejects.toThrow(/pdf/);
    // 参数不合法时**不该调用桥** —— 那会把明显错误变成一次真实的 COM 调用
    expect(bridge.officeConvert).not.toHaveBeenCalled();
  });

  it('★ 参数缺失 → 拒绝，且给出是哪个参数', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await expect(tool.execute({ target: 'b.pdf' }, {} as never)).rejects.toThrow(/source/);
    await expect(tool.execute({ source: 'a.docx' }, {} as never)).rejects.toThrow(/target/);
  });

  it('★★ 桥抛错时**如实抛出**（不吞成成功）', async () => {
    const bridge = fakeBridge({
      officeConvert: vi.fn(async () => {
        throw new Error('源文件不存在：C:/nope.docx');
      }),
    });
    const tool = desktopTools(bridge, ALL_CAPS).find((s) => s.name === 'desktop_office_convert');
    if (!tool) throw new Error('工具缺失');

    await expect(
      tool.execute({ source: 'C:/nope.docx', target: 'b.pdf' }, {} as never),
    ).rejects.toThrow(/源文件不存在/);
  });
});

describe('desktop_screenshot', () => {
  it('返回路径与尺寸', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_screenshot');
    if (!tool) throw new Error('工具缺失');

    const r = await tool.execute({}, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1920×1080');
  });

  it('preview 说明"会截到屏幕上的一切"（用户要能看懂风险）', async () => {
    const tool = desktopTools(fakeBridge(), ALL_CAPS).find((s) => s.name === 'desktop_screenshot');
    if (!tool?.preview) throw new Error('缺少 preview');

    const text = await tool.preview({}, {} as never);
    // 检查**语义**而不是某个固定词：
    //   ① 说了"整个屏幕 / 所有窗口" ② 说了"私人/无关内容也会进来"
    expect(text).toMatch(/整个屏幕|所有窗口/);
    expect(text).toMatch(/私人|无关/);
  });
});
