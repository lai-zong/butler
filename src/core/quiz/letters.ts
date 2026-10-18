/**
 * 选项字母工具 —— **唯一实现**。
 *
 * ★ 为什么单独成文件：
 *
 *   同一个"把各种写法归一成选项字母"的规则，有两个真实调用方：
 *     · **模型输出侧**（`prompts/schemas.ts`）：模型给的 `answer` 有五种写法
 *     · **用户提交侧**（`quiz/grade.ts`）：用户提交的选项也可能带前缀/小写
 *
 *   两处各写一份必然漂移 —— 而漂移的表现是**批改永远判错**，
 *   比崩溃更难发现（没有人会怀疑"答案明明对了却报错"是归一化不一致）。
 */

/** 选项字母表：一道题最多 8 个选项 */
export const OPTION_LETTERS = 'ABCDEFGH';

/** 去掉选项自带的 `A.` / `1.` 前缀 —— 否则界面会显示「A. A. 油炸」。 */
export function stripOptionPrefix(option: string): string {
  return option.replace(/^\s*(?:[A-Ha-h]|\d{1,2})\s*[.、,:：)）]\s*/, '').trim();
}

/**
 * 把"某处给出的答案"归一化成选项字母。
 *
 * ⚠️ 实测会遇到的写法（少处理一种就会导致批改永远判错）：
 *   ① 纯字母     `"B"` / `"b"`
 *   ② 字母+分隔  `"B. 清蒸"` / `"B、清蒸"` / `"B) 清蒸"`
 *   ③ 数字下标   `2`（1 基）
 *   ④ 选项原文   `"清蒸"`
 *   ⑤ 互相包含   `"清蒸"` vs 选项 `"清蒸（少油）"`
 *
 * @param options 该题的选项文本（用于 ④⑤ 反查）
 * @returns 归一化后的字母；无法判定时返回 `undefined`
 */
export function toOptionLetter(
  raw: string | number | undefined,
  options: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined;
  const t = String(raw).trim();
  if (t.length === 0) return undefined;

  // ① 纯字母
  const bare = /^([A-Ha-h])$/.exec(t);
  if (bare?.[1] !== undefined) return bare[1].toUpperCase();

  // ② 字母 + 分隔符
  const prefixed = /^([A-Ha-h])\s*[.、,:：)）]/.exec(t);
  if (prefixed?.[1] !== undefined) return prefixed[1].toUpperCase();

  // ③ 数字下标（1 基）
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length && n <= OPTION_LETTERS.length) {
    return OPTION_LETTERS[n - 1];
  }

  // ④ 与选项原文完全一致
  const exact = options.findIndex((o) => o.trim() === t);
  if (exact >= 0 && exact < OPTION_LETTERS.length) return OPTION_LETTERS[exact];

  // ⑤ 互相包含（答案写"清蒸"，选项是"清蒸（少油）"）
  const partial = options.findIndex((o) => {
    const ot = o.trim();
    return ot.length > 0 && (ot.includes(t) || t.includes(ot));
  });
  if (partial >= 0 && partial < OPTION_LETTERS.length) return OPTION_LETTERS[partial];

  return undefined;
}
