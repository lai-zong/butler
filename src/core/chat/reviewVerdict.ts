/**
 * 审查结论推断。
 *
 * ★ 新审查 Agent 输出的是完整 Markdown，而不是旧的 criteriaChecks JSON。
 *   UI 仍然需要 pass/fail/unknown 才能显示历史徽标；这里只做**保守**推断：
 *   - 明确出现“不通过/未通过/无法通过/不能原样交付” → fail；
 *   - 否则出现非否定语境的“通过/pass” → pass；
 *   - 两边都不明确 → unknown。
 *
 * ⚠️ 这是展示层归类，不是安全判定；真正的审查正文仍以 Markdown 为准。
 */
export type InferredReviewVerdict = 'pass' | 'fail' | 'unknown';

const FAIL_PATTERN = /不通过|未通过|无法通过|不能原样交付|不可原样交付|拒绝交付|不满足交付/;
const PASS_PATTERN = /(^|[^不未无])通过|通过（|pass\b/i;

export function inferReviewVerdict(markdown: string): InferredReviewVerdict {
  const text = markdown.replace(/\r/g, '').trim();
  if (text.length === 0) return 'unknown';
  if (FAIL_PATTERN.test(text)) return 'fail';
  if (PASS_PATTERN.test(text)) return 'pass';
  return 'unknown';
}
