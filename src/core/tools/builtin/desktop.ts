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
  if (caps['uiautomation'] === true) out.push(listWindowsTool(bridge));
  // ③ 视觉需要 mss 或 PIL 之一
  if (caps['mss'] === true || caps['PIL'] === true) out.push(screenshotTool(bridge));
  return out;
}
