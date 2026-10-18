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
import { PATH_LABEL, type ExecutionPath } from '../../memory/operation.js';
import type { OperationMemoryStore } from '../../memory/operations.js';
import type { ToolResult, ToolSpec } from '../types.js';

/**
 * 让模型**主动查历史经验**（只读）。
 *
 * ★ 为什么做成工具而不是塞进系统提示：
 *   ① 不用改提示词装配链（少一处耦合）
 *   ② 只在真要动手时查一次，比每次会话都注入更省 token
 *   ③ 查不到就明说"没有历史" —— 不编造经验
 *
 * ⚠️ 但必须配合"工具描述里提示它存在"，否则模型不知道要查。
 *    这件事在 `withMemory` 包装的动作工具描述里做了（见下方 `hintExperience`）。
 */
export function experienceTool(ops: OperationMemoryStore): ToolSpec {
  return {
    name: 'desktop_experience',
    description:
      '查这类任务在本机的操作历史：哪条路成功率高、哪条试过多次都失败。' +
      '动手前不确定该用哪种方式（应用接口 / 无障碍 / 坐标点击）时先查一次。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要做什么（自然语言，例如「把一批 Word 转成 PDF」）' },
        app: { type: 'string', description: '目标应用（可选，例如「设置」「酷狗音乐」）' },
      },
      required: ['task'],
    },
    tier: 'readOnly',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `查操作历史：${String(a['task'] ?? '?')}`;
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const task = requireString(a, 'task');
      const app = typeof a['app'] === 'string' ? a['app'] : undefined;

      const r = ops.recommend({ task, ...(app !== undefined ? { app } : {}) });

      if (!r.usedMemory) {
        return {
          ok: true,
          output:
            `这类任务（签名 ${r.taskSignature}）在本机**还没有历史记录**。` +
            `\n按默认顺序尝试即可：应用接口 → 无障碍模式调用 → 坐标点击（能不动鼠标键盘就不动）。`,
          data: r,
          durationMs: 0,
        };
      }

      const lines = r.ranked.map((p, i) => {
        const label = PATH_LABEL[p.path];
        const flag = p.fromExperience ? '实测' : '先验';
        const giveUp = p.adviseGivingUp === true ? '  ⚠️ 试过多次都失败，建议放弃这条路' : '';
        /**
         * ★ 过期提示（方案 §6.3⑤ 第 3 层）——
         *   与"建议放弃"分开说：那条是"一直不行"，这条是"**现在**可能不行了"，
         *   要求模型**先验证再用**，而不是永久排除（环境可能已经变了）。
         */
        const stale = p.stale === true ? '  ⚠️ **可能已过期**（连续失败），用之前先验证' : '';
        return `${i + 1}. ${label}（${flag}，得分 ${p.score.toFixed(2)}）：${p.why}${giveUp}${stale}`;
      });

      const discouraged =
        r.discouraged.length > 0
          ? `\n\n⛔ 已知不可行：${r.discouraged.map((p) => PATH_LABEL[p]).join('、')}`
          : '';
      const staleNote =
        r.stale.length > 0
          ? `\n\n⚠️ 有 ${r.stale.length} 条经验**可能已过期**（连续失败）：` +
            `${r.stale.map((p) => PATH_LABEL[p]).join('、')}。` +
            `\n它们**仍在推荐里**（软件可能已经修好了），但**用之前必须先验证**，别盲信。`
          : '';

      /**
       * ★ 应用级经验（跨任务说法）。
       *
       * 实测：同一件事的不同中文说法会得到**不同签名**，所以任务级常常空手而归；
       * 而"在这个应用上哪条路走得通"是**跨说法稳定**的 —— 这时就用它兜底。
       */
      const appNote =
        r.appLevel !== undefined
          ? `\n\n📌 **该应用的整体经验**（「${r.appLevel.app}」，跨 ${r.appLevel.samples} 次操作）：\n` +
            r.appLevel.ranked
              .map(
                (p, i) =>
                  `${i + 1}. ${PATH_LABEL[p.path]}（得分 ${p.score.toFixed(2)}）：${p.why}` +
                  (p.stale === true ? '  ⚠️ 用之前先验证' : ''),
              )
              .join('\n')
          : '';

      return {
        ok: true,
        output: `这类任务的历史经验（签名 ${r.taskSignature}）：\n${lines.join('\n')}${discouraged}${staleNote}${appNote}`,
        data: r,
        durationMs: 0,
      };
    },
  };
}

/**
 * 阶梯级 → 执行路径（操作记忆里的 `ExecutionPath`）。
 *
 * ★ 两套编号早就该对齐：`ExecutionPath` 本来就是按"用哪种方式"分的
 *   （`api` / `cli` / `uia` / `vision` / `manual`），与方案 §9.4 的四级阶梯同构。
 */
export function rungToPath(rung: 1 | 2 | 3 | 4): ExecutionPath {
  switch (rung) {
    case 1:
      return 'api'; // 应用接口 / COM
    case 2:
      return 'uia'; // 无障碍模式调用
    case 3:
      return 'uia'; // 窗口消息：仍属无障碍手段，只是兼容性更差
    case 4:
      return 'vision'; // 真实鼠标键盘注入（视觉/坐标路线）
  }
}

/** 从参数里猜"这是哪个应用"（用于签名里的 app 维度） */
function appOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as Record<string, unknown>;
  // 桌面工具都用 window 指目标应用
  const w = a['window'];
  if (typeof w === 'string' && w.trim().length > 0) return w.trim();
  return undefined;
}

/**
 * 把一次桌面动作的结果记进操作记忆（方案 §6.3 ①）。
 *
 * ★★ 为什么要包一层而不是改每个工具：
 *   ① 记录逻辑只有一处，不会出现"某个工具忘了记"
 *   ② **成功和失败都要记** —— 只记成功就学不到"这条路上次失败了"
 *
 * ⚠️ 三条纪律：
 *   ① `ctx.task` 缺失时**不记录** —— 没有任务文本就没有签名，
 *      硬记只会污染记忆（下次匹配不上，还占位置）
 *   ② 记录失败**不能影响工具结果** —— 记忆是旁路，不是主路径
 *   ③ 失败要把原因带上（`lastFailure`），下次才知道"该规避什么"
 */
function withMemory(spec: ToolSpec, ops: OperationMemoryStore): ToolSpec {
  const original = spec.execute;
  return {
    ...spec,
    execute: async (args, ctx): Promise<ToolResult> => {
      const started = Date.now();
      let result: ToolResult | undefined;
      let thrown: unknown;
      try {
        result = await original(args, ctx);
        return result;
      } catch (err) {
        thrown = err;
        throw err;
      } finally {
        // ⚠️ 记录本身失败绝不能盖住真实结果（旁路原则）
        try {
          const task = ctx.task;
          if (task !== undefined && task.trim().length > 0) {
            const ok = result?.ok === true && thrown === undefined;
            const path = rungToPath(spec.rung ?? 1);
            // ★ 工具显式声明了应用域就用它（如 office），否则从参数取（如 window）
            const app = spec.actionApp ?? appOf(args);
            ops.recordAttempt({
              task,
              ...(app !== undefined ? { app } : {}),
              path,
              success: ok,
              durationMs: Date.now() - started,
              ...(ok
                ? {}
                : {
                    failureReason:
                      thrown !== undefined
                        ? thrown instanceof Error
                          ? thrown.message
                          : String(thrown)
                        : (result?.output ?? '未知失败'),
                  }),
              method: spec.summarize(args),
            });
          }
        } catch {
          // 旁路失败，静默
        }
      }
    },
  };
}

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
    // ★ 阶梯级（D-32）：层① 应用接口：Word 用自己的 COM 接口干活
    rung: 1,
    /**
     * ⚠️ 参数里只有文件路径，从扩展名推出来的 `docx` **不是应用**。
     *    显式声明成 `office`，否则应用级聚合会混进一个叫 `docx` 的假应用。
     */
    actionApp: 'office',
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
      /**
       * ★★ 校验**效果**，不校验动作（方案 §6.3⑤ 第 2 层）。
       *
       * ⚠️ 后端返回 `bytes: getsize(dst) if isfile(dst) else 0` ——
       *    也就是说**文件没生成时它不报错，只是给个 0**。
       *    如果这里直接把"调用没抛异常"当作成功，就会出现
       *    "工具说转好了，磁盘上什么也没有"。
       *    所以 0 字节必须判失败。
       */
      if (r.bytes <= 0) {
        return {
          ok: false,
          output: `转换**未成功**：命令没报错，但目标文件是 0 字节或不存在（${r.target}）。这通常意味着 Word 其实没保存成功。`,
          data: r,
          durationMs: 0,
        };
      }
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
      const tree = await bridge.uiaTree(window, depth, max);
      const nodes = tree.nodes;
      const text = nodes
        .map((n) => `${'  '.repeat(n.depth)}[${n.type}] ${n.name || '（无名）'}`)
        .join('\n');
      /**
       * ⚠️ 截断必须说出来。
       *    模型看到"控件树（200 个）"会以为界面就这些，进而得出
       *    "没有那个按钮"的错误结论 —— 而实际是没遍历完。
       */
      const truncNote = tree.truncated
        ? `\n\n⚠️ **已截断**：已达到上限（深度 ${tree.limits.depth} / 数量 ${tree.limits.max}）。` +
          `\n这棵树**不完整** —— 你要找的控件可能在未遍历的部分。` +
          `\n请调大 max（或缩小 depth）后重试，不要据此断言"没有该控件"。`
        : '';
      return {
        ok: true,
        output: `控件树（${nodes.length} 个${tree.truncated ? '，已截断' : ''}）：\n${text}${truncNote}`,
        data: { nodes, count: nodes.length, truncated: tree.truncated, limits: tree.limits },
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
    // ★ 阶梯级（D-32）：层② 模式调用：Invoke / Toggle / Select，不碰鼠标键盘
    rung: 2,
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
    // ★ 阶梯级（D-32）：层② 模式调用：ValuePattern，不碰键盘
    rung: 2,
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
 * ② UIA 层：**等到界面就绪**再往下走（只读）。
 *
 * ★★ 为什么必须有这个工具：
 *
 *   界面变化是异步的。没有它，模型只能"调一次 → 找不到 → 失败"，
 *   或者在验证脚本里写 `sleep(2500)`（**闭眼数秒**）：
 *   - 机器慢一点 → 2.5 秒不够 → 假失败
 *   - 其实 300ms 就好了 → 白等 2.2 秒
 *
 *   "盯着看到"和"闭眼数秒"的差别，在真实使用里就是**偶发失败率**的差别。
 *
 * ⚠️ 轮询在 Node 侧做，不新增 Python op —— 复用 `uiaFind`。
 *    `uiaFind` 在窗口/控件不存在时会抛错，这里把"抛错"当作**还没就绪**，
 *    只有超时才判失败。
 */
export function waitForTool(bridge: DesktopBridgePort): ToolSpec {
  return {
    name: 'desktop_wait_for',
    description:
      '等待界面就绪：轮询直到目标窗口（或窗口里的某个控件）出现。' +
      '给 name 时等该控件出现，不给时只等窗口出现。' +
      '比"先截图看看"更省，比"直接操作"更稳 —— 界面变化是异步的。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口标题的一部分' },
        name: { type: 'string', description: '要等待的控件名（精确匹配）。不填则只等窗口' },
        controlType: { type: 'string', description: '限定控件类型，用于消歧' },
        timeoutMs: { type: 'number', description: '最长等待毫秒数（默认 10000，上限 120000）' },
        pollMs: { type: 'number', description: '轮询间隔毫秒（默认 250，最小 100）' },
      },
      required: ['window'],
    },
    tier: 'readOnly',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const n = typeof a['name'] === 'string' ? `控件「${a['name']}」` : '窗口';
      return `等待「${String(a['window'] ?? '?')}」的${n}出现`;
    },
    execute: async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const window = requireString(a, 'window');
      const name = typeof a['name'] === 'string' ? a['name'] : '';
      const ct = typeof a['controlType'] === 'string' ? a['controlType'] : undefined;

      const timeoutRaw = typeof a['timeoutMs'] === 'number' ? a['timeoutMs'] : 10_000;
      const timeoutMs = Math.min(Math.max(timeoutRaw, 500), 120_000);
      const pollRaw = typeof a['pollMs'] === 'number' ? a['pollMs'] : 250;
      const pollMs = Math.min(Math.max(pollRaw, 100), 5_000);

      const started = Date.now();
      let attempts = 0;
      let lastError = '';

      for (;;) {
        attempts++;
        try {
          if (name.length === 0) {
            // 只等窗口：列出窗口，看有没有匹配标题的
            const wins = await bridge.listWindows(200);
            if (wins.some((w) => w.title.includes(window))) {
              const waited = Date.now() - started;
              return {
                ok: true,
                output: `窗口「${window}」已就绪（等了 ${waited}ms，轮询 ${attempts} 次）`,
                data: { waitedMs: waited, attempts, found: 'window' },
                durationMs: waited,
              };
            }
            lastError = '窗口还没出现';
          } else {
            const r = await bridge.uiaFind(window, name, ct);
            if (r.count > 0) {
              const waited = Date.now() - started;
              return {
                ok: true,
                output: `控件「${name}」已出现（等了 ${waited}ms，轮询 ${attempts} 次，${r.count} 个匹配）`,
                data: { waitedMs: waited, attempts, found: 'control', matches: r.matches },
                durationMs: waited,
              };
            }
            lastError = '控件还没出现';
          }
        } catch (err) {
          // ⚠️ 窗口/控件不存在时 uiaFind 会抛错 —— 那是"还没就绪"，不是故障
          lastError = err instanceof Error ? err.message : String(err);
        }

        const elapsed = Date.now() - started;
        if (elapsed + pollMs > timeoutMs) {
          return {
            ok: false,
            output:
              `等待超时（${timeoutMs}ms，轮询 ${attempts} 次）：` +
              `窗口「${window}」${name.length > 0 ? `的控件「${name}」` : ''}始终没出现。` +
              `最后一次原因：${lastError}`,
            data: { waitedMs: elapsed, attempts, found: null, timeoutMs },
            durationMs: elapsed,
          };
        }
        await sleep(pollMs);
      }
    },
  };
}

/** 等待（Node 侧，不引入依赖） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /**
   * 操作记忆仓储（可选）。
   *
   * ★ 给了才会记录"这类任务用哪种方式成功"（方案 §6.3 ①）。
   *   ⚠️ 不给时行为**与之前完全一致** —— 记忆是旁路，不是依赖。
   */
  ops?: OperationMemoryStore,
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
    out.push(waitForTool(bridge));
  }
  // ③ 视觉需要 mss 或 PIL 之一
  if (caps['mss'] === true || caps['PIL'] === true) out.push(screenshotTool(bridge));

  // ★ 只对**会动手**的工具包记忆（读类不记：阶梯描述的是"动手"的手段）
  if (ops === undefined) return out;
  // 让模型知道可以查历史（否则它不会主动调 desktop_experience）
  out.push(experienceTool(ops));
  return out.map((s) => (s.rung !== undefined ? withMemory(s, ops) : s));
}
