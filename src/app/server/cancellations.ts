import type { EventLog } from '@/core/events/log.js';
import type { SessionEvent } from '@/core/events/types.js';
import type { SessionCancellationDto } from '@/app/ui/lib/types.js';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 从事件流构造会话取消记录。
 *
 * ⚠️ 只读事件，不读 ChatMessage：取消时可能没有助手消息，
 *    所以不能靠 messages 反推取消。
 */
export function toSessionCancellations(
  log: EventLog,
  sessionId: string,
): readonly SessionCancellationDto[] {
  return log
    .byType('session.cancelled')
    .filter((e: SessionEvent) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return p['sessionId'] === sessionId;
    })
    .map((e: SessionEvent) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        reason: str(p['reason'], 'user_cancelled'),
        phase: str(p['phase'], 'unknown'),
        fromSeq: num(p['fromSeq']),
        toSeq: num(p['toSeq']),
        toolCalls: num(p['toolCalls']),
        toolResults: num(p['toolResults']),
        createdAt: e.createdAt,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}
