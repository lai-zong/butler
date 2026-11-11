import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { latestCompactionForChat } from '../compactionScope.js';

function add(
  log: EventLog,
  payload: Record<string, unknown>,
): void {
  log.append({
    type: 'context.compacted',
    actor: 'butler',
    payload: { compactedCount: 1, beforeTokens: 10, afterTokens: 1, ok: true, ...payload },
    createdAt: 1,
  });
}

describe('context.compacted 会话隔离', () => {
  it('只取当前聊天会话的摘要', () => {
    const log = new EventLog('s_runtime_shared');
    add(log, { chatSessionId: 'chat_a', summaryText: 'A 的摘要', throughMessageId: 'a1' });
    add(log, { chatSessionId: 'chat_b', summaryText: 'B 的摘要', throughMessageId: 'b1' });
    add(log, { chatSessionId: 'chat_a', summaryText: 'A 的最新摘要', throughMessageId: 'a2' });

    const b = latestCompactionForChat(log.byType('context.compacted'), 'chat_b');
    expect(b.summaryText).toBe('B 的摘要');
    expect(b.throughMessageId).toBe('b1');

    const a = latestCompactionForChat(log.byType('context.compacted'), 'chat_a');
    expect(a.summaryText).toBe('A 的最新摘要');
    expect(a.throughMessageId).toBe('a2');
  });

  it('旧事件没有 chatSessionId 时不复用', () => {
    const log = new EventLog('s_runtime_shared');
    add(log, { summaryText: '旧的全局摘要', throughMessageId: 'old' });
    expect(latestCompactionForChat(log.byType('context.compacted'), 'chat_a')).toEqual({});
  });
});
