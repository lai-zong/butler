/**
 * 操作记忆 —— 记忆化执行的数据模型
 *
 * 设计依据：方案 § 6.3（记忆化执行，**差异化核心**）、§ 4.2
 *
 * ★ 差异化主张的原话：
 *   "**竞品是无状态的** —— 每次任务都从零判断该用什么方法。
 *    **本项目有记忆** —— 同一个任务做得越多越快越准。"
 *
 *   例子：
 *     第 1 次：给 Excel 加一列 → 试了 UI 自动化 → 失败 → 改用 COM → 成功
 *     第 5 次：给 Excel 加一列 → **直接走 COM**（不再尝试 UI 路径）
 *
 * ⚠️ 措辞纪律（方案 § 6.2）：
 *    "API/CLI 优先于模拟点击"是**基本功，不构成创新**。
 *    差异在**记住哪种方式在这台机器上更可靠** —— 也就是这个模块。
 */

// ═══════════════════════════════════════════════════════════
// 三类操作记忆
// ═══════════════════════════════════════════════════════════

/**
 * - `method`      方法记忆：这类任务该走哪条路径（COM / UI / CLI / API）
 * - `preference`  偏好记忆：用户希望怎么做（删除前确认、批量前预览）
 * - `environment` 环境记忆：这台机器的实际情况（Python 路径、DPI、工具可用性）
 */
export type OperationKind = 'method' | 'preference' | 'environment';

/**
 * 方法记忆里的"路径"分类。
 *
 * 与方案 § 6.1 的三层能力模型对应：
 *   api    → 应用接口 / COM / AppleScript
 *   cli    → 命令行
 *   uia    → 无障碍接口（Windows UI Automation）
 *   vision → 截图 + 坐标点击（最不可靠）
 *   manual → 只能用人工（记录下来，避免反复尝试）
 */
export type ExecutionPath = 'api' | 'cli' | 'uia' | 'vision' | 'manual';

export const PATH_LABEL: Record<ExecutionPath, string> = {
  api: '应用接口 / COM',
  cli: '命令行',
  uia: '无障碍接口 UIA',
  vision: '视觉识别与坐标点击',
  manual: '需人工操作',
};

/** 成功率统计（方法记忆专属）。 */
export interface OperationEffectiveness {
  readonly attempts: number;
  readonly succeeded: number;
  readonly lastUsedAt: number;
  /** 最近一次失败的原因（用于下次规避） */
  readonly lastFailure?: string;
  /** 平均耗时（毫秒），用于在成功率相同时比较 */
  readonly avgDurationMs: number;
  /**
   * **连续**失败次数（方案 §6.3⑤ 第 3 层：失败即降信心，连续失败自动归档）。
   *
   * ★ 为什么必须与"累计失败"分开：
   *   累计失败反映"这条路历史上不太行"，但**成功多少次都冲不掉它**；
   *   连续失败反映"**这条路现在可能已经不行了**"（软件更新、界面改版），
   *   而且**一次成功就该清零** —— 那才是"发现路修好了就继续走"。
   *
   * ⚠️ 可选：旧事件里没有这个字段，读回时按 0 处理（不破坏历史）。
   */
  readonly consecutiveFailures?: number;
}

export interface OperationMemory {
  readonly id: string;
  readonly userId: string;
  readonly kind: OperationKind;
  /**
   * 任务签名 —— 用于匹配"同类任务"。
   *
   * ⚠️ 签名的构造是这套机制的关键（见 `taskSignature`）：
   *    太细 → 永远匹配不上，等于没记；
   *    太粗 → 把不同任务混为一谈，给出错误的方法。
   */
  readonly taskSignature: string;
  /** 人类可读的任务描述（界面展示用） */
  readonly taskLabel: string;
  /** 记忆内容：方法路径 / 偏好要求 / 环境事实 */
  readonly content: string;
  /** 仅方法记忆：走的是哪条路径 */
  readonly path?: ExecutionPath;
  /** 仅方法记忆：成功率统计 */
  readonly effectiveness?: OperationEffectiveness;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ═══════════════════════════════════════════════════════════
// 任务签名
// ═══════════════════════════════════════════════════════════

/**
 * 构造任务签名。
 *
 * ★ 设计要点：签名要**跨表述稳定**。
 *   "给 Excel 加一列" / "在 Excel 里插入一列" / "Excel 新增列"
 *   应当得到同一个签名 —— 否则同一个任务做十次还是十次全新尝试。
 *
 * ★ 实现策略（改过一版）：
 *   第一版先把中文做同义词替换、再分词。结果"加一列"被替换成 "add"+"column"
 *   而中间没有空格，整段粘成 `里addcolumn`，签名彻底失效。
 *   **中英语序不同，替换后再分词是错的** —— 改为：分词与特征提取都直接
 *   在**原文**上做（中文按字匹配、英文按词匹配），最后才拼签名。
 */
export function taskSignature(input: {
  readonly task: string;
  readonly app?: string;
}): string {
  const raw = input.task;
  const app = (input.app ?? extractApp(raw) ?? '').toLowerCase();
  const verb = extractCanonical(raw, VERB_WORDS);
  const object = extractObject(raw, app);
  return [verb, object.value, app].filter((s) => s.length > 0).join('|');
}

/** 规范动作 → 中文写法（用于在原文里匹配）。 */
const VERB_WORDS: Record<string, readonly string[]> = {
  add: ['新增', '添加', '插入', '增加', '加一', '加个', '加上', '加入', 'add', 'insert'],
  remove: ['删除', '移除', '去掉', '清除', '删掉', 'remove', 'delete'],
  edit: ['修改', '更改', '改成', '改为', '编辑', 'edit', 'modify'],
  query: ['查询', '查找', '搜索', '检索', '找出', '看看', 'query', 'search', 'find'],
  aggregate: ['统计', '汇总', '计算', '求和', 'aggregate', 'sum', 'count'],
  convert: ['转换', '导出', '另存', 'convert', 'export'],
  launch: ['打开', '启动', '运行', 'launch', 'open', 'start'],
  copy: ['复制', '拷贝', 'copy'],
  move: ['移动', '挪到', 'move'],
};

/** 规范对象 → 中文写法。 */
const OBJECT_WORDS: Record<string, readonly string[]> = {
  column: ['一列', '列', 'column'],
  row: ['一行', '行', 'row'],
  file: ['文件', '文档', 'file', 'document'],
  sheet: ['表格', '工作表', 'sheet'],
  folder: ['文件夹', '目录', 'folder', 'directory'],
  pdf: ['pdf'],
  image: ['图片', '截图', 'image', 'picture'],
  mail: ['邮件', 'mail', 'email'],
};

const KNOWN_APPS = ['excel', 'word', 'powerpoint', 'ppt', 'wps', 'chrome', 'edge', 'vscode', 'outlook'];

/** 在原文里找到某个规范词的哪种写法出现了，返回规范键。 */
function extractCanonical(raw: string, table: Record<string, readonly string[]>): string {
  const lower = raw.toLowerCase();
  for (const [canonical, words] of Object.entries(table)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) return canonical;
  }
  return '';
}

function extractApp(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  return KNOWN_APPS.find((a) => lower.includes(a));
}

/**
 * 抽对象。
 *
 * 优先用规范对象词表匹配（"列""文件""表格"…）；
 * 匹配不到时退化为"去掉动作词与应用名后的第一个实义词"。
 */
function extractObject(
  raw: string,
  app: string,
): { readonly value: string } {
  const canonical = extractCanonical(raw, OBJECT_WORDS);
  if (canonical.length > 0) return { value: canonical };

  // 退化路径：剥掉动作写法与应用名，取剩余里第一个长度 ≥2 的中文/英文词
  let rest = raw.toLowerCase();
  for (const words of Object.values(VERB_WORDS)) {
    for (const w of words) rest = rest.split(w.toLowerCase()).join(' ');
  }
  if (app.length > 0) rest = rest.split(app).join(' ');
  rest = rest.replace(/[，。、；：！？,.;:!?"'（）()【】\[\]]/g, ' ');

  const stop = new Set(['的', '了', '在', '把', '给', '对', '里', '中', '个', '一', 'the', 'a', 'to', 'in', 'of']);
  const words = rest.split(/\s+/).filter((w) => w.length >= 2 && !stop.has(w));
  return { value: words[0] ?? '' };
}

/** 两个签名是否算同一类任务。 */
export function sameTaskKind(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  const pa = a.split('|');
  const pb = b.split('|');
  // 动作与对象都一致即视为同类（应用可以不同 —— 同一个操作方法常跨应用通用）
  return pa[0] === pb[0] && pa[1] === pb[1];
}
