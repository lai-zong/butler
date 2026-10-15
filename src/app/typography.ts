/**
 * 内容排版 —— 把模型输出按「视觉层次」分类
 *
 * 设计依据：用户反馈
 *   「输出的文字排版太密集了……【菜单】可以标粗标大、"能量估算"可以标粗不标大。
 *     总的来说是为了让用户看着舒适，看得清晰易懂，
 *     而不是麻木地将文字打印出来。」
 *
 * ★★ 为什么要单独一个模块，而不是在渲染里塞几条正则：
 *
 *   识别"哪一行是标题"是一个**判断**，会有误判。
 *   误判的表现是**视觉上的**（把正文加粗了），不会报错，
 *   所以特别需要能**离线测**——拿真实模型输出喂进来，
 *   看每一行被判成什么。
 *
 *   ⚠️ 这里刻意**不调模型**来判断层次：
 *     一个纯排版问题不值得再一次 API 往返，
 *     而且那会让"显示"依赖"网络"——文本已经有了，排版不该再等。
 *
 * ★ 分层只做三级，不追求完整 Markdown：
 *   | 层级      | 视觉          | 触发                          |
 *   | major    | 加粗 + 加大    | `## x` / `【x】` / 短独立行     |
 *   | minor    | 加粗          | `**x**` / `x：` / 短冒号行     |
 *   | body     | 正常          | 其余                          |
 *
 *   ⚠️ 不做斜体、引用、代码块 —— 仆人的产出是清单与短句，不是富文本。
 *      语法支持得越多，误判面越大。
 */

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type LineKind =
  /** 一级标题：加粗 + 加大 */
  | 'major'
  /** 二级标题：只加粗 */
  | 'minor'
  /** 列表项（原文以 - / * / 数字. 开头）*/
  | 'list'
  /** 普通段落 */
  | 'body'
  /** 分隔线 */
  | 'divider'
  /** 空行 */
  | 'blank';

export interface TypedLine {
  readonly kind: LineKind;
  /**
   * 要显示的文本（**已去掉标题标记**）。
   *
   * ⚠️ 这是本模块的核心职责：`【菜单】` 里的方括号要去掉，
   *    因为视觉上"加粗加大"已经表达了它是标题，
   *    再留着方括号是**双重标注**，看起来更乱。
   */
  readonly text: string;
  /**
   * 标题后面跟的正文（如果有）。
   *
   * ⚠️ 模型常写 `【菜式方向】两人份、四菜一汤` ——
   *    标题与内容在同一行。拆开才能让标题真的"标粗标大"，
   *    否则整行都会被加粗，等于没强调。
   */
  readonly rest?: string;
  /** 列表项的有序编号（`1.` → 1），无序列表为 undefined */
  readonly listNumber?: number;
  /**
   * 字段清单的条目（`生鲜：鲜虾400g、牛里脊300g` → 拆成多项）。
   *
   * ★ 为什么单列一个字段：它是**行内列表**的展开结果，
   *   渲染时要按"子项"排版（比列表项更紧凑），
   *   与 `text`（一整行文字）不是一回事。
   */
  readonly items?: readonly string[];
}

// ═══════════════════════════════════════════════════════════
// 判定阈值
// ═══════════════════════════════════════════════════════════

/**
 * 独立成行的短句算标题吗？这是最容易误判的一条。
 *
 * ⚠️ 判据不是"多短"，而是**"像不像正文"**：
 *    正文有结尾标点、有句读、有语气词；标题没有。
 *    所以宁可从严 —— **漏判只是少一次加粗，误判是把正文加粗了**，
 *    后者看起来更糟。
 */
export const HEADING_MAX_CHARS = 18;

/** 字段清单里单项的最大字数（真实清单项都在 12 字以内）。 */
export const FIELD_ITEM_MAX_CHARS = 16;

/** 字段清单里各项的**平均**字数上限 —— 拦住「最长项侥幸过关」的情形。 */
export const FIELD_ITEM_AVG_CHARS = 12;

/** 正文的迹象：出现这些就**不**当标题。 */
const SENTENCE_MARKERS = /[。！？；]|^[这那它他她我你]|^(所以|但是|不过|因为|如果|可以|建议|注意|另外|此外|同时)/;

/** 行尾是这些标点的，不是标题（正文句读）。 */
const TRAILING_PUNCT = /[。．.！!？?；;，,、]$/;

// ═══════════════════════════════════════════════════════════
// 主分类
// ═══════════════════════════════════════════════════════════

/** 把一段文本切成带层次的若干行。 */
export function classifyLines(text: string): readonly TypedLine[] {
  const raw = text.split('\n');
  const out: TypedLine[] = [];

  for (const line of raw) {
    out.push(classifyLine(line));
  }

  /**
   * 后处理：**连续空行折叠成一个**。
   *
   * ⚠️ 模型常连打两三个空行，按原样渲染会撑出大片空白 ——
   *    那是"稀疏"而不是"舒适"。节奏要靠统一的间距给出，
   *    不能靠原文里碰巧有几个换行。
   */
  const collapsed: TypedLine[] = [];
  for (const l of out) {
    if (l.kind === 'blank' && collapsed[collapsed.length - 1]?.kind === 'blank') continue;
    collapsed.push(l);
  }
  // 首尾的空白行去掉（间距由容器控制）
  while (collapsed[0]?.kind === 'blank') collapsed.shift();
  while (collapsed[collapsed.length - 1]?.kind === 'blank') collapsed.pop();

  return collapsed;
}

/** 分类单行。 */
export function classifyLine(line: string): TypedLine {
  const trimmed = line.trim();

  if (trimmed.length === 0) return { kind: 'blank', text: '' };

  // ── 分隔线 ──
  if (/^[-*_]{3,}$/.test(trimmed)) return { kind: 'divider', text: '' };

  // ── Markdown 标题 `## x` ──（模型偶尔会用）
  const mdHead = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (mdHead) {
    const level = mdHead[1]!.length;
    const body = mdHead[2]!.trim();
    return {
      kind: level <= 2 ? 'major' : 'minor',
      text: stripBold(body),
    };
  }

  // ── 【标题】内容 / 【标题】 ──
  //
  // ★ 这是中文产出里最常见的标题写法。
  //   ⚠️ 必须只认**开头**的方括号：`1. 蒜蓉粉丝蒸虾（主菜·海鲜）—— 鲜虾400g`
  //      里也有括号，但那不是标题。
  const bracket = /^【([^】]{1,24})】\s*(.*)$/.exec(trimmed);
  if (bracket) {
    const head = bracket[1]!.trim();
    const rest = bracket[2]!.trim();
    // ⚠️ 【菜单】后面跟的长正文要拆开，否则整行加粗等于没强调
    return {
      kind: 'major',
      text: head,
      ...(rest.length > 0 ? { rest } : {}),
    };
  }

  // ── 整行加粗 `**x**` ──
  const wholeBold = /^\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/.exec(trimmed);
  if (wholeBold) {
    const head = wholeBold[1]!.trim();
    const rest = wholeBold[2]!.trim();
    return {
      kind: rest.length > 0 ? 'minor' : 'minor',
      text: head,
      ...(rest.length > 0 ? { rest } : {}),
    };
  }

  // ── 列表项 ──
  const unordered = /^[-*·]\s+(.+)$/.exec(trimmed);
  if (unordered) {
    return { kind: 'list', text: stripBold(unordered[1]!.trim()) };
  }
  const ordered = /^(\d+)[.、)]\s*(.+)$/.exec(trimmed);
  if (ordered) {
    return {
      kind: 'list',
      text: stripBold(ordered[2]!.trim()),
      listNumber: Number(ordered[1]),
    };
  }

  // ── 以冒号结尾的短行 → 二级标题 ──
  //
  // ★ 用户举的例子「能量估算」就是这一类：它是小标题，**标粗不标大**。
  const colon = /^([^：:]{1,HEADING_MAX_CHARS})[：:]\s*$/.exec(trimmed);
  if (colon) {
    return { kind: 'minor', text: colon[1]!.trim() };
  }

  // ── ★ 字段清单 → 拆成子项 ──
  //
  // 「生鲜：鲜虾400g、牛里脊300g、鸡蛋4个、嫩豆腐1盒、番茄2个、黄瓜1根…」
  //
  // ⚠️ 这是**行内列表**：本质是一串并列项，只是写成了"标签：值1、值2、值3"。
  //    按普通段落渲染时它会折成两三行，每行都塞满 —— 实测这就是
  //    整段内容里唯一还显密的地方（菜单那部分因为本来就有序号，不密）。
  //
  //    拆成子项后每项独占一行，能一眼扫。
  const field = splitFieldList(trimmed);
  if (field !== null) {
    return { kind: 'list', text: field.label, items: field.items };
  }

  // ── 短独立行 → 一级标题 ──
  if (looksLikeHeading(trimmed)) {
    return { kind: 'major', text: stripBold(trimmed) };
  }

  return { kind: 'body', text: trimmed };
}

/**
 * 识别「标签：值1、值2、值3」并拆开。
 *
 * ⚠️ 判定要**保守**，否则会把正常句子拆碎：
 *   · 标签必须短（≤8 字）—— `生鲜`、`干货调料`、`时间`、`预计花费`
 *   · 值必须真的像并列项（顿号 ≥3 个）—— 少于 3 个只是顺带提了一句
 *   · **每一项都要短**—— 长句里的顿号是句读，不是列表
 *   · **平均长度也要短**—— 光看最长项不够：
 *     「把鲜虾去壳后…腌制十分钟备用、牛里脊逆纹切薄片、鸡蛋打散、豆腐切块」
 *     最长项 27 字会被放宽到 30 的阈值放过。
 *
 * ★ 拿真实数据校准过：`鲜虾400g`(6) `牛里脊300g`(7) `黑胡椒碎`(4)
 *   真实清单项**都在 12 字以内**，所以阈值可以定得很紧。
 *   定紧的代价只是"偶尔漏拆"（仍按原样显示，不会出错），
 *   而误拆的代价是"把一句食谱步骤拆成四行"，那更糟。
 */
function splitFieldList(line: string): { label: string; items: string[] } | null {
  const m = /^([^：:]{1,8})[：:]\s*(.+)$/.exec(line);
  if (!m) return null;

  const label = m[1]!.trim();
  const value = m[2]!.trim();

  // 顿号数量门槛 —— 太少就不是并列清单
  const separators = (value.match(/、/g) ?? []).length;
  if (separators < 3) return null;

  const items = value
    .split('、')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (items.length < 4) return null;

  // 任一项过长 → 说明这是句子，不是清单
  if (items.some((s) => s.length > FIELD_ITEM_MAX_CHARS)) return null;

  // ★ 平均长度也要短 —— 这一条拦住了"最长项"侥幸过关的情形
  const avg = items.reduce((n, s) => n + s.length, 0) / items.length;
  if (avg > FIELD_ITEM_AVG_CHARS) return null;

  return { label, items };
}

/**
 * 短独立行是否像标题。
 *
 * ⚠️ 从**严**：宁可漏判（少一次加粗），不可误判（把正文加粗）。
 */
function looksLikeHeading(s: string): boolean {
  // 去掉加粗标记后再判断长度（`**能量估算**` 的可见长度是 4）
  const visible = stripBold(s);

  if (visible.length === 0 || visible.length > HEADING_MAX_CHARS) return false;

  // 有句读 / 句尾标点 → 是正文
  if (SENTENCE_MARKERS.test(visible)) return false;
  if (TRAILING_PUNCT.test(visible)) return false;

  // 有冒号在中间（不是结尾）→ 多半是正文（"时间：3 点出发"）
  if (/[：:]/.test(visible)) return false;

  // 含数字带单位的量词 → 是正文（"约 30 分钟"）
  if (/\d+\s*(分钟|小时|克|g|kg|ml|人份|次|元|天)/.test(visible)) return false;

  return true;
}

/** 去掉 `**加粗**` 标记，保留文字。 */
export function stripBold(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

// ═══════════════════════════════════════════════════════════
// 可测的说明
// ═══════════════════════════════════════════════════════════

/**
 * 分析结果的可读摘要 —— 供验证脚本打印，人工核对判定是否合理。
 *
 * ★ 存在的理由：排版误判是**视觉问题**，不会报错。
 *   把它打印成人能看的形式，才能一眼看出"这行不该是标题"。
 */
export function describeClassification(lines: readonly TypedLine[]): string {
  const mark: Record<LineKind, string> = {
    major: '█ ',
    minor: '▓ ',
    list: '  • ',
    body: '    ',
    divider: '―――',
    blank: '',
  };
  return lines
    .map((l) => {
      if (l.kind === 'blank') return '';
      if (l.kind === 'divider') return mark.divider;
      const head = `${mark[l.kind]}${l.text}`;
      return l.rest !== undefined ? `${head}  ⟨正文⟩ ${l.rest}` : head;
    })
    .join('\n');
}
