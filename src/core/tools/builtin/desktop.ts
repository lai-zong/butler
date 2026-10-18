/**
 * 桌面控制工具（v8 · 方案 §9）
 *
 * ★ 三级能力与权限分级**一一对应**（方案 §9.4）：
 *
 *   | 层 | 工具 | tier | 依据 |
 *   |---|---|---|---|
 *   | ① COM（应用接口）| `desktop_office_convert` | `normal` | 方案：需确认（写操作）|
 *   | ② UIA（无障碍）| `desktop_list_windows` | `readOnly` | 只读，不影响系统状态 |
 *   | ③ 视觉 | `desktop_screenshot` | `highRisk` | 方案：**每次确认 + 高风险标记**（截图会看到用户屏幕上的全部内容）|
 *
 * ⚠️ 为什么 `screenshot` 不是 `readOnly`：
 *    它"不改变系统状态"没错，但它**读取了用户屏幕上的一切**
 *    （聊天记录、密码框、私人照片）。
 *    按 `readOnly` 自动放行等于让模型随时偷看屏幕 —— 那不该是默认行为。
 *
 * ⚠️ 为什么没有 click / type：
 *    那属于"每次确认"的视觉层操作，而"询问"这一档要等 C6（可恢复挂起）才能实现。
 *    现在注册成 `dangerous` 就等于**永远禁用**（`WebPermissionPolicy` 对 dangerous 恒 false），
 *    注册了也用不了。等 C6 落地再接 —— 在那之前不制造"有这个能力"的错觉。
 */

import type { DesktopBridgePort } from '../../desktop/port.js';
import type { ToolSpec } from '../types.js';

/**
 * 拼接输出路径时**不做任何路径归一化** —— 交给 Python 侧的 `os.path.abspath`。
 * 这里只做"参数形状"校验，把明显错误的调用挡在架构之外。
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return v;
}

/**
 * ① COM 层：Office 文档 → PDF。
 *
 * ★ 这是方案 §9.2 点名的演示场景：
 *   「Word 后台干活，全程不弹窗」——
 *   对比"截图找菜单点导出"的方案，差别不是快一点，而是**稳一个数量级**。
 */
export function officeConvertTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_office_convert',
    description:
      '用 Office 自己的接口（COM）把 .docx/.doc 转成 PDF。文档在后台转换，不会弹出 Word 窗口。' +
      'source 与 target 都用绝对路径，target 必须以 .pdf 结尾。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源文件绝对路径（.docx 或 .doc）' },
        target: { type: 'string', description: '目标 PDF 绝对路径（以 .pdf 结尾）' },
      },
      required: ['source', 'target'],
    },
    tier: 'normal',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `把 ${String(a['source'] ?? '?')} 转成 PDF`;
    },
    /**
     * 只读预览：告诉用户"这次会动到什么"。
     * ⚠️ 不检查文件是否存在 —— 那是执行期的事，预览不该做副作用。
     */
    preview: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `将读取「${String(a['source'] ?? '?')}」并写出「${String(a['target'] ?? '?')}」\n` +
        '转换由 Word 在后台完成，不会弹出窗口，也不会修改源文件。';
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const source = requireString(a, 'source');
      const target = requireString(a, 'target');
      if (!target.toLowerCase().endsWith('.pdf')) {
        throw new Error('target 必须以 .pdf 结尾');
      }
      const r = await bridge.officeConvert(source, target);
      return {
        ok: true,
        output: `已生成 PDF：${r.target}（${r.bytes} 字节）`,
        data: r,
        durationMs: 0,
      };
    },
  };
}

/**
 * ② UIA 层：列出当前顶层窗口。
 *
 * ⚠️ 用**控件语义**（标题/类名/进程）而不是像素 —— 分辨率、主题、语言变了它也还认得。
 */
export function listWindowsTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_list_windows',
    description:
      '列出当前打开的顶层窗口（标题、窗口类名、进程 id）。' +
      '用于确认"用户现在开着什么应用"，再决定下一步操作。只读，不改变任何东西。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少个窗口（默认 40）' },
      },
    },
    tier: 'readOnly',
    summarize: () => '查看当前打开了哪些窗口',
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const rawLimit = a['limit'];
      const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 200) : 40;
      const windows = await bridge.listWindows(limit);
      const text =
        windows.length === 0
          ? '当前没有可列出的顶层窗口'
          : windows
              .map((w, i) => `${i + 1}. ${w.title || '（无标题）'} — ${w.className} (pid ${w.processId})`)
              .join('\n');
      return {
        ok: true,
        output: text,
        data: { windows, count: windows.length },
        durationMs: 0,
      };
    },
  };
}

/**
 * ③ 视觉层：截图。
 *
 * ⚠️ 只**截图**，不点击 —— 点击属于不可逆操作，等 C6（询问开关）落地再接。
 *    这一条是刻意的：截图能帮模型"看清楚"，而点击会改变用户的世界。
 */
export function screenshotTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_screenshot',
    description:
      '截取整个屏幕并保存为 PNG，返回文件路径。' +
      '⚠️ 会把屏幕上的全部内容（包括其它窗口）都截下来，仅在确实需要"看屏幕"时使用。',
    parameters: { type: 'object', properties: {} },
    tier: 'highRisk',
    summarize: () => '截取当前屏幕',
    preview: async () =>
      '将截取整个屏幕并保存为图片。屏幕上所有窗口的内容都会进入这张图，包括与任务无关的私人内容。',
    execute: async () => {
      const r = await bridge.screenshot();
      return {
        ok: true,
        output: `已截图：${r.path}（${r.width}×${r.height}，后端 ${r.backend}）`,
        data: r,
        durationMs: 0,
      };
    },
  };
}

/**
 * ② UIA 层：按**元素**读取控件（只读，先看清再动手）。
 *
 * ★ 为什么"先读再操作"要单独一个工具：
 *   名字必须精确匹配，而 WinUI 里同名控件常常有好几个（父子嵌套、兄弟并列）。
 *   先 `find` 能看到有几个匹配、各自支持什么模式 —— 再决定怎么动。
 *   直接操作等于让它瞎试。
 */
export function uiaReadTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_uia_read',
    description:
      '读取某个窗口的界面结构（只读）。给 name 时查找该名字的控件、报告有几个匹配以及各自支持的操作模式；' +
      '不给 name 时导出整棵控件树。用于"先看清楚再动手"。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口标题的一部分（如「设置」）' },
        name: { type: 'string', description: '控件名（精确匹配）。不填则导出整棵树' },
        controlType: {
          type: 'string',
          description: '限定控件类型：button/listitem/tab/edit/toggle/checkbox/text/combobox/menuitem',
        },
        depth: { type: 'number', description: '导出树时最大深度（默认 8）' },
        max: { type: 'number', description: '导出树时最多多少个控件（默认 200）' },
      },
      required: ['window'],
    },
    tier: 'readOnly',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const n = typeof a['name'] === 'string' ? a['name'] : '（整棵树）';
      return `读取「${String(a['window'] ?? '?')}」的界面结构：${n}`;
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const window = requireString(a, 'window');
      const name = typeof a['name'] === 'string' ? a['name'] : '';

      if (name.length > 0) {
        const ct = typeof a['controlType'] === 'string' ? a['controlType'] : undefined;
        const r = await bridge.uiaFind(window, name, ct);
        const lines =
          r.count === 0
            ? `没有找到名为「${name}」的控件`
            : r.matches
                .map(
                  (m, i) =>
                    `${i + 1}. [${m.type}] 位置 (${m.rect.join(',')})` +
                    `${m.automationId ? ` id=${m.automationId}` : ''}` +
                    `${m.patterns && m.patterns.length > 0 ? ` 可用操作=${m.patterns.join('/')}` : ' （无可用操作模式）'}`,
                )
                .join('\n');
        return {
          ok: true,
          output: `共 ${r.count} 个匹配：\n${lines}`,
          data: r,
          durationMs: 0,
        };
      }

      const depth = typeof a['depth'] === 'number' ? Math.min(Math.max(a['depth'], 1), 12) : 8;
      const max = typeof a['max'] === 'number' ? Math.min(Math.max(a['max'], 1), 500) : 200;
      const nodes = await bridge.uiaTree(window, depth, max);
      const text = nodes
        .map((n) => `${'  '.repeat(n.depth)}[${n.type}] ${n.name || '（无名）'}`)
        .join('\n');
      return {
        ok: true,
        output: `控件树（${nodes.length} 个）：\n${text}`,
        data: { nodes, count: nodes.length },
        durationMs: 0,
      };
    },
  };
}

/**
 * ② UIA 层：按模式操作控件（导航项、开关、按钮、折叠项）。
 *
 * ★★ 这个工具的核心不是"点一下"，而是**操作后读回状态校验**。
 *    `verified` 为 false 时，工具**返回失败** ——
 *    "点了但状态没变"绝不能被报成成功，否则模型会以为改好了。
 */
export function uiaInvokeTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_uia_invoke',
    description:
      '按无障碍接口操作窗口里的一个控件（不需要鼠标、不需要窗口在前台）。' +
      'action：toggle（开关）、select（导航项/列表项）、invoke（按钮）、expand/collapse（折叠项）。' +
      '⚠️ 控件名必须精确匹配；同名控件有多个时会被拒绝，此时先用 desktop_uia_read 看清楚。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口标题的一部分' },
        name: { type: 'string', description: '控件名（精确匹配）' },
        action: {
          type: 'string',
          enum: ['toggle', 'select', 'invoke', 'expand', 'collapse'],
          description: '操作类型',
        },
        controlType: {
          type: 'string',
          description: '限定控件类型（button/listitem/tab/...），用于消歧',
        },
      },
      required: ['window', 'name', 'action'],
    },
    tier: 'highRisk',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `对「${String(a['window'] ?? '?')}」里的「${String(a['name'] ?? '?')}」执行 ${String(a['action'] ?? '?')}`;
    },
    preview: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return (
        `将对窗口「${String(a['window'] ?? '?')}」中的控件「${String(a['name'] ?? '?')}」执行 ` +
        `${String(a['action'] ?? '?')}。这会改变该应用的界面状态。`
      );
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const window = requireString(a, 'window');
      const name = requireString(a, 'name');
      const actionRaw = requireString(a, 'action');
      const allowed = ['toggle', 'select', 'invoke', 'expand', 'collapse'] as const;
      type Action = (typeof allowed)[number];
      if (!(allowed as readonly string[]).includes(actionRaw)) {
        throw new Error(`action 必须是 ${allowed.join('/')} 之一，收到 ${actionRaw}`);
      }
      const action = actionRaw as Action;
      const ct = typeof a['controlType'] === 'string' ? a['controlType'] : undefined;

      const r = await bridge.uiaAction(window, name, action, ct);

      const desc =
        `[${r.control.type}] ${r.control.name}` +
        (r.control.automationId ? ` (id=${r.control.automationId})` : '');
      const stateText =
        r.before === null || r.after === null
          ? '（该操作没有可读回的状态）'
          : `${String(r.before)} → ${String(r.after)}`;

      /**
       * ★ 校验语义**按操作区分**（这一点写错过一次，必须说清）：
       *
       *   · `toggle` = "翻一下" → 状态**必须翻转**才算生效
       *   · `select` = "让它处于选中态" → **已经是选中态就是成功**（幂等）
       *
       * 第一版对两者都用"状态变了才算成功"，于是"本来就选中"被误判为失败。
       * 那不是操作失败，是把幂等操作当成了翻转操作。
       */
      if (r.verified === false) {
        const why = action === 'select' ? '目标未被选中' : '状态没有变化';
        return {
          ok: false,
          output: `操作未生效（${why}）：${desc}  ${stateText}`,
          data: r,
          durationMs: 0,
        };
      }

      return {
        ok: true,
        output: `已执行 ${action}：${desc}  状态 ${stateText}`,
        data: r,
        durationMs: 0,
      };
    },
  };
}

/**
 * ② UIA 层：给标准输入框设值。
 *
 * ⚠️ 自绘 UI（酷狗 `kugou_ui` 那类）会"声称支持但抛 COMError" ——
 *    这时**如实报错**，不退回坐标点击（那更不可靠，且会打错目标）。
 */
export function uiaSetValueTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_uia_set_value',
    description:
      '给标准输入框设置文本（走 ValuePattern，不需要键盘）。' +
      '⚠️ 只对实现了 ValuePattern 的标准控件有效；自绘界面的输入框会失败并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口标题的一部分' },
        name: { type: 'string', description: '输入框名（精确匹配）' },
        value: { type: 'string', description: '要填入的文本' },
      },
      required: ['window', 'name', 'value'],
    },
    tier: 'highRisk',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `把「${String(a['window'] ?? '?')}」的「${String(a['name'] ?? '?')}」设为「${String(a['value'] ?? '?')}」`;
    },
    preview: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `将在窗口「${String(a['window'] ?? '?')}」的输入框「${String(a['name'] ?? '?')}」中写入文本「${String(a['value'] ?? '?')}」。`;
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const window = requireString(a, 'window');
      const name = requireString(a, 'name');
      const value = requireString(a, 'value');
      const r = await bridge.uiaSetValue(window, name, value);
      if (!r.verified) {
        return {
          ok: false,
          output: `写入未生效：期望「${value}」，实际「${r.after}」`,
          data: r,
          durationMs: 0,
        };
      }
      return {
        ok: true,
        output: `已写入：[${r.control.type}] ${r.control.name} 前值「${r.before}」→ 现值「${r.after}」`,
        data: r,
        durationMs: 0,
      };
    },
  };
}

/**
 * 按本机能力组装工具集。
 *
 * ★ **不猜**：`caps` 来自 Python 侧的真实探测（`ping` 的返回），
 *   缺哪个模块就不注册对应工具 —— 于是模型看到的是"没有这个工具"，
 *   而不是"调了才失败"。
 *
 * ⚠️ 返回空数组是**合法结果**（例如没装 win32com 的机器）：
 *    上层据此什么都不注册，桌面能力不可用但系统照常工作。
 */
export function desktopTools(
  bridge: DesktopBridgePort,
  caps: Readonly<Record<string, boolean>>,
): readonly ToolSpec[] {
  const out: ToolSpec[] = [];
  // ① COM 需要 win32com
  if (caps['win32com'] === true) out.push(officeConvertTool(bridge));
  // ② UIA 需要 uiautomation
  if (caps['uiautomation'] === true) {
    out.push(listWindowsTool(bridge));
    out.push(uiaReadTool(bridge));
    out.push(uiaInvokeTool(bridge));
    out.push(uiaSetValueTool(bridge));
  }
  // ③ 视觉需要 mss 或 PIL 之一
  if (caps['mss'] === true || caps['PIL'] === true) out.push(screenshotTool(bridge));
  return out;
}
