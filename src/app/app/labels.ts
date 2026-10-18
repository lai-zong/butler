/**
 * 术语 → 人话的映射与纯函数
 *
 * ★★ 为什么单独一个文件（不带 `'use client'`）：
 *
 *   ⚠️ 踩过的坑：这些映射原先放在 `ui.tsx` 里，而那个文件有 `'use client'`。
 *      于是**服务端组件调用它们会直接报错**：
 *
 *        ⨯ Attempted to call fitnessTone() from the server
 *          but fitnessTone is on the client.
 *
 *      `'use client'` 是**模块级**标记 —— 它把这个文件里的一切都划给客户端，
 *      包括普通函数与常量。而普通函数**只有客户端组件能调用**。
 *
 *   ★ 规律：**纯数据与纯函数不要放进带 `'use client'` 的文件。**
 *     放在这里，服务端组件与客户端组件都能用。
 *     只有"需要交互（useState/onClick）"的东西才该标 `'use client'`。
 *
 * ★ 另一件事：这一层的存在是**必需的**，不是锦上添花。
 *   项目内部有大量开发者术语（fitness / lifecycle / memClass / advisory…），
 *   方案与代码里用它们是对的，但**界面上不能出现** ——
 *   用户是大众，看不懂就是看不懂。
 *
 * ★ 翻译原则：
 *   · 说**结果**而不是机制（「暂时不用了」而不是「dormant」）
 *   · 说**程度**而不是数值（「比较管用」而不是「0.72」）——
 *     精确数值对大众没有意义，反而像仪表盘
 */

// ═══════════════════════════════════════════════════════════
// 记忆
// ═══════════════════════════════════════════════════════════

/** 记忆类别 → 人话 */
export const MEMORY_KIND: Record<string, string> = {
  global_constraint: '硬性要求',
  global_shared: '通用信息',
  sensitive: '私密信息',
  domain: '专属经验',
};

/** 记忆状态 → 人话 */
export const MEMORY_STATE: Record<string, string> = {
  candidate: '待确认',
  active: '在用',
  dormant: '暂时不用了',
  archived: '已归档',
};

/** 适应度数值 → 人话（⚠️ 不把原始数值显示给大众） */
export function fitnessWord(v: number): string {
  if (v >= 0.75) return '很管用';
  if (v >= 0.55) return '比较管用';
  if (v >= 0.35) return '一般';
  return '不太管用';
}

export type Tone = 'quiet' | 'ok' | 'warn' | 'danger' | 'accent';

/** 适应度 → 色调 */
export function fitnessTone(v: number): Tone {
  if (v >= 0.75) return 'ok';
  if (v >= 0.35) return 'quiet';
  return 'warn';
}

// ═══════════════════════════════════════════════════════════
// 对话
// ═══════════════════════════════════════════════════════════

/** 审查结论 → 人话 */
export const VERDICT_WORD: Record<string, string> = {
  accepted: '已完成',
  rejected: '已打回重做',
  needsDecision: '需要你决定',
  clarifying: '需要你补充信息',
};

// ★ v7（F3）：领域名的唯一来源是核心模块，界面不自己维护一份
import { domainName } from '@/core/domain/types.js';

/**
 * 领域 → 中文名（v7 · F3）
 *
 * ★★ 改了两件事：
 *
 *   ① **值去掉「仆人」**：'生活仆人' → '生活'
 *      ⚠️ 单执行者架构下没有仆人。界面继续写「生活仆人」等于
 *         告诉用户一个不存在的东西 —— 这是**界面在撒谎**，不只是措辞旧。
 *
 *   ② **不再自己维护一张表**，改为委托 `domainName()`
 *      ⚠️ 原先 `core/domain/types.ts` 与这里各有一份领域名映射。
 *         两份表的代价是**漂移**：改一处另一处不知道（E3 已踩过同类问题）。
 *
 *   ⚠️ 常量名仍是 `DOMAIN_NAME` —— 它有 13 处引用，
 *      改名与「值修正」混在一起会让 diff 无法审阅。名字单独一次改。
 */
export const DOMAIN_NAME: Record<string, string> = {
  life: domainName('life'),
  health: domainName('health'),
  study: domainName('study'),
  work: domainName('work'),
  code: domainName('code'),
  butler: '管家',
};

/** 工具名 → 人话（⚠️ 英文工具名对大众是噪音） */
export const TOOL_WORD: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  list_dir: '查看目录',
  stat_path: '查看文件信息',
  search_files: '搜索文件',
  run_command: '执行命令',
  submit_report: '提交结论',
  fetch_url: '抓取网页',
};

export function toolWord(name: string): string {
  return TOOL_WORD[name] ?? name;
}

/** 仆人执行状态 → 人话 */
export const DOMAIN_STATUS: Record<string, string> = {
  done: '做完了',
  failed: '没做成',
  blocked: '被卡住了',
};
