/**
 * 读取产品级全局 AGENTS（`config/AGENTS.md`）
 *
 * ★ 为什么在 app 层读文件：
 *   core 层不碰文件系统（ADR 0004）。core 只拿到快照，
 *   `globalAgentsBlock()` 负责把正文转成 system 消息。
 *
 * ★ 三条产品纪律：
 *   ① 文件缺失 / 读不了 / 内容损坏 → 返回空规则 + 原因，
 *      **绝不阻断对话**（对话入口照常继续）。
 *   ② 只读**这一个文件**：不递归、不找工作区 AGENTS、不处理 import。
 *      ⚠️ 本模块**只读**：不提供、也不应新增任何写入/编辑函数。
 *         防止会话工具改写全局规则由 C 侧的 workspace/path guard 负责
 *         （`config/` 整目录受保护），这里不重复实现权限作用域。
 *   ③ 每次加载都记录 SHA-256 与长度，写进 `session.settings` 事件，
 *      审计时能回答“这一轮用的是哪份全局规则”。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  emptyGlobalAgentsSnapshot,
  type GlobalAgentsSnapshot,
} from '@/core/prompts/globalAgents.js';

export const GLOBAL_AGENTS_DIR = 'config';
export const GLOBAL_AGENTS_FILE = 'AGENTS.md';

/**
 * 提示词里最多放多少字符。
 *
 * ⚠️ 超出部分截掉并记 `truncated: true`，不静默塞爆上下文。
 *   32K 字符已经远大于“产品级全局规则”应有的体量。
 */
export const MAX_GLOBAL_AGENTS_CHARS = 32_000;

export function globalAgentsPath(root = process.cwd()): string {
  return join(root, GLOBAL_AGENTS_DIR, GLOBAL_AGENTS_FILE);
}

export async function loadGlobalAgents(root = process.cwd()): Promise<GlobalAgentsSnapshot> {
  const path = globalAgentsPath(root);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return emptyGlobalAgentsSnapshot({
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // BOM 去掉；NUL 视为损坏（二进制误命名成 .md）
  const text = raw.replace(/^\uFEFF/, '');
  if (text.includes('\u0000')) {
    return emptyGlobalAgentsSnapshot({
      error: '文件包含 NUL 字符，按损坏处理',
    });
  }

  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const fullLength = text.length;
  const truncated = fullLength > MAX_GLOBAL_AGENTS_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_GLOBAL_AGENTS_CHARS) : text,
    hash,
    length: fullLength,
    loaded: true,
    truncated,
  };
}
