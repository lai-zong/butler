/**
 * 旧数据修复：把历史里"删了但原文还在"的记忆抹干净。
 *
 * 背景：v9 之前的版本 `forget()` 只删内存状态，事件流里的
 * `memory.created` / 快照仍带原文。升级后第一次启动需要补一次迁移：
 *   · 幂等：已经抹过（内容已是占位符）就跳过；
 *   · 只碰被 `intervention.forgotten` 指名道姓的记忆；
 *   · 不新增事件 —— 迁移是"让历史符合新语义"，不是新的业务事实。
 */

import type { EventLog } from '../events/log.js';
import { FORGOTTEN_PLACEHOLDER, findMemoryContent } from '../events/scrub.js';

export interface ForgottenRepairResult {
  /** 补抹的记忆条数 */
  readonly memories: number;
  /** 被改动的事件条数 */
  readonly events: number;
}

export function repairForgottenContent(log: EventLog): ForgottenRepairResult {
  let memories = 0;
  let events = 0;

  const forgottenIds = log
    .all()
    .filter((e) => e.type === 'intervention.forgotten')
    .map((e) => {
      const p = e.payload;
      if (typeof p !== 'object' || p === null) return '';
      const id = (p as Record<string, unknown>)['memoryId'];
      return typeof id === 'string' ? id : '';
    })
    .filter((id) => id.length > 0);

  for (const id of forgottenIds) {
    const content = findMemoryContent(log.all(), id);
    if (content === undefined || content.length === 0 || content === FORGOTTEN_PLACEHOLDER) {
      continue;
    }
    const changed = log.scrubForMemory(id, content);
    if (changed > 0) {
      memories += 1;
      events += changed;
    }
  }

  return { memories, events };
}
