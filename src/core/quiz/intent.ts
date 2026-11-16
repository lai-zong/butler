/**
 * 识别“用户明确要求出题”的意图。
 *
 * ★ 只用于选择执行路径：命中的轮次走单次结构化输出，确保 quiz 进入 artifacts；
 *   不改变会话模式，也不持久化任何状态。
 * ★ 宁可漏判也不要误伤普通问答：普通“这道题怎么做”不应触发结构化出题。
 */
export function isPracticeRequest(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;

  // 中文：出/拟/生成/设计/来/给/帮/做 + 题/练习/测试/测验/小测
  if (/(?:出|拟|生成|设计|来|准备)\s*[^。！？\n]{0,16}?(?:道|个)?\s*(?:题|练习|测验|测试|小测|quiz)/i.test(t)) {
    return true;
  }

  // “几道题 / 一道练习”这类数量在前面的写法
  if (/(?:几道|一道|两道|三道|\d+\s*道)\s*(?:题|练习)/i.test(t)) {
    return true;
  }

  // 英文
  if (/\bquiz\s+me\b/i.test(t)) return true;
  if (/\btest\s+me\b/i.test(t)) return true;
  if (/\b(?:practice|quiz|make|create|generate|give me)\b[^.\n]{0,40}\b(?:questions?|quiz)\b/i.test(t)) {
    return true;
  }

  return false;
}
