/**
 * 每日日记管线。
 *
 * 默认处理“前一天”（本地 04:00 日界）。每个 session 每天最多一次。
 * 这是常规长期记忆的唯一入口；上下文压缩/按轮总结不写长期记忆。
 */

import type { SessionStore } from '../chat/types.js';
import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { ModelPort } from '../ports/model.js';
import type { MemoryStore } from '../memory/store.js';
import type { DiaryStore } from './store.js';
import type { DiaryEntry, DiarySourceMessage } from './types.js';
import { generateDiary } from './generate.js';
import { dayWindow, previousDayKey } from './time.js';

export const MIN_USER_MESSAGES_FOR_DIARY = 4;
export const MAX_SESSIONS_PER_DAILY_RUN = 50;

export interface DailyDiaryArgs {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly chat: SessionStore;
  readonly diary: DiaryStore;
  readonly memory: MemoryStore;
  /** 默认处理前一天；测试可显式指定。 */
  readonly dayKey?: string;
  readonly minUserMessages?: number;
}

export interface DailyDiarySessionResult {
  readonly sessionId: string;
  readonly dayKey: string;
  readonly status: 'created' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly diaryId?: string;
  readonly itemCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface DailyDiaryResult {
  readonly dayKey: string;
  readonly sessions: readonly DailyDiarySessionResult[];
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

function toDiaryMessages(
  chat: SessionStore,
  sessionId: string,
  startAt: number,
  endAt: number,
): readonly DiarySourceMessage[] {
  return chat
    .messagesOf(sessionId)
    .filter((m) => m.createdAt >= startAt && m.createdAt < endAt)
    .filter((m) => m.status === 'done' || m.status === 'interrupted')
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
    }));
}

/** 某会话在某天是否有足够内容生成日记。 */
export function diaryWorthy(
  messages: readonly DiarySourceMessage[],
  minUserMessages = MIN_USER_MESSAGES_FOR_DIARY,
): boolean {
  let userMessages = 0;
  for (const m of messages) if (m.role === 'user' && m.text.trim().length > 0) userMessages += 1;
  return userMessages >= minUserMessages;
}

/**
 * 跑一次昨日日记。失败不抛整轮，逐会话记录。
 *
 * ⚠️ 这里只生成日记，不直接把条目写入记忆仓库。
 *   条目的准入/试行/图谱映射属于后续阶段；日记是它们的事实来源。
 */
export async function runDailyDiaries(args: DailyDiaryArgs): Promise<DailyDiaryResult> {
  const dayKey = args.dayKey ?? previousDayKey(args.clock.now());
  const window = dayWindow(dayKey);
  const sessions = args.chat.listSessions().slice(0, MAX_SESSIONS_PER_DAILY_RUN);
  const results: DailyDiarySessionResult[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const session of sessions) {
    if (args.diary.has(`session:${session.id}`, dayKey)) {
      results.push({ sessionId: session.id, dayKey, status: 'skipped', reason: 'already exists' });
      continue;
    }

    const messages = toDiaryMessages(args.chat, session.id, window.startAt, window.endAt);
    if (!diaryWorthy(messages, args.minUserMessages)) {
      results.push({ sessionId: session.id, dayKey, status: 'skipped', reason: 'not enough content' });
      continue;
    }

    try {
      const generated = await generateDiary({
        model: args.model,
        clock: args.clock,
        sessionId: session.id,
        userId: session.userId,
        dayKey,
        messages,
        minUserMessages: args.minUserMessages ?? MIN_USER_MESSAGES_FOR_DIARY,
        existingMemories: args.memory
          .list({})
          .filter((m) => m.lifecycle === 'active' || m.lifecycle === 'candidate')
          .slice(0, 30)
          .map((m) => ({ id: m.id, kind: m.kind, content: m.content })),
      });
      args.diary.record(generated.entry);
      inputTokens += generated.usage.inputTokens;
      outputTokens += generated.usage.outputTokens;
      results.push({
        sessionId: session.id,
        dayKey,
        status: 'created',
        diaryId: generated.entry.id,
        itemCount: generated.entry.items.length,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.log.append({
        type: 'diary.failed',
        actor: 'system',
        payload: { sessionId: session.id, dayKey, error: message.slice(0, 500) },
        createdAt: args.clock.now(),
      });
      results.push({ sessionId: session.id, dayKey, status: 'failed', reason: message });
    }
  }

  return {
    dayKey,
    sessions: results,
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    usage: { inputTokens, outputTokens },
  };
}

export function diarySummary(result: DailyDiaryResultLike): string {
  return `日记 ${result.dayKey}：生成 ${result.created} 篇，跳过 ${result.skipped}，失败 ${result.failed}`;
}

interface DailyDiaryResultLike {
  readonly dayKey: string;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

/** 供后续阶段使用：日记条目 → 候选（暂不做准入）。 */
export function diaryItemsOf(entries: readonly DiaryEntry[]): number {
  return entries.reduce((n, d) => n + d.items.length, 0);
}
