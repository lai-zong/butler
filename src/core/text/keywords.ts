/**
 * 中文文本相关性判定（无分词依赖）
 *
 * 用途有两处，都需要"这段文本是否谈到了那个概念"：
 *   ① 硬约束校验：某仆人的产出有没有处理这条约束（butler/hardConstraints.ts）
 *   ② 约束注入筛选：这条约束与本次子任务是否相关（butler/dispatch.ts）
 *
 * 不引入分词库的理由：目标只是"完全没提" vs "提到了"的粗判，
 * 精确语义匹配交给 LLM 监督层，这里做好确定性初筛即可。
 */

/** 常见虚词 —— 剥离后才好比较实词 */
const STOP_WORDS: readonly string[] = [
  '你对', '我对', '你是', '我是', '他的', '她的', '你的', '我的',
  '严重', '非常', '特别', '一定', '必须', '不能', '严禁', '禁止',
  '注意', '记得', '需要', '正在', '已经', '还有', '以及',
  '的', '了', '和', '与', '或', '及', '是', '在', '要',
];

/**
 * 剥离虚词与标点，得到核心字串。
 *
 * 例：「你对花生严重过敏」→「花生过敏」
 */
export function coreOf(text: string): string {
  let s = text;
  for (const w of STOP_WORDS) s = s.split(w).join('');
  return s.replace(/[^\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9]/g, '').trim();
}

/**
 * `haystack` 中是否出现了 `core` 的任一长度 ≥ minLen 的连续片段。
 *
 * 从最长片段开始试，命中即返回 —— 长片段命中意味着更强的相关信号。
 */
export function hasAnyNgram(haystack: string, core: string, minLen = 2): boolean {
  for (let len = core.length; len >= minLen; len--) {
    for (let i = 0; i + len <= core.length; i++) {
      if (haystack.includes(core.slice(i, i + len))) return true;
    }
  }
  return false;
}

/**
 * 判断 `candidate` 是否谈到了 `reference` 里的概念。
 *
 * 任一方向命中即算相关 —— 因为两边的详略程度不同：
 * 约束写「花生过敏」，子任务写「设计无花生菜单」，
 * 两边的核心串不完全一致，但都包含「花生」，应当判为相关。
 *
 * 提不出实词时返回 **true**（宁可多注入，也不漏掉必要约束）。
 */
export function isRelevant(candidate: string, reference: string): boolean {
  const a = coreOf(candidate);
  const b = coreOf(reference);
  if (a.length < 2 || b.length < 2) return true;
  return hasAnyNgram(a, b) || hasAnyNgram(b, a);
}
