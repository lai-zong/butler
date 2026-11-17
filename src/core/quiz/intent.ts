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

/**
 * 出题请求是否**依赖外部资料**。
 *
 * ★ 只用于决定要不要先做一次只读取证；不改变“出题”本身。
 *   “帮我出三道数学题”不需要读文件；
 *   “根据笔记/附件/工作区文档出题”必须先取证，否则模型只能编。
 */
export function requiresEvidenceForPractice(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;

  const evidenceVerb =
    /(?:读|读取|阅读|打开|查看|分析|参考|结合|根据|基于|按照|从|总结|整理)/;
  const evidenceSource =
    /(?:文件|笔记|文档|资料|附件|目录|工作区|代码库|表格|报告|论文|教材|课程|数据|记录|\.(?:md|txt|pdf|docx?|csv|json|ya?ml|xlsx?|pptx?))/i;
  return evidenceVerb.test(t) && evidenceSource.test(t);
}
