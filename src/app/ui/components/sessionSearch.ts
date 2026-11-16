/** 会话搜索：只匹配用户能看到的标题与最后一条消息摘要。 */
import type { SessionSummary } from '../lib/types.js';

export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return `${session.title}\n${session.lastPreview}`.toLowerCase().includes(q);
}

export function filterSessionsByQuery(
  sessions: readonly SessionSummary[],
  query: string,
): readonly SessionSummary[] {
  const q = query.trim();
  if (q.length === 0) return sessions;
  return sessions.filter((session) => matchesSessionQuery(session, q));
}
