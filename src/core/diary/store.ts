/**
 * 日记仓储 —— 事件溯源、可重放、每个作用域每天唯一。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { DiaryEntry } from './types.js';

export interface DiaryQuery {
  readonly sessionId?: string;
  readonly userId?: string;
  readonly dayKey?: string;
}

function keyOf(scopeId: string, dayKey: string): string {
  return `${scopeId}::${dayKey}`;
}

function isDiaryEntry(value: unknown): value is DiaryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<DiaryEntry>;
  return (
    typeof v.id === 'string' &&
    typeof v.scopeId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.dayKey === 'string' &&
    typeof v.content === 'string' &&
    Array.isArray(v.items) &&
    Array.isArray(v.sourceMessageIds) &&
    typeof v.createdAt === 'number'
  );
}

export class DiaryStore {
  private readonly entries = new Map<string, DiaryEntry>();

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
  ) {
    this.replayFromLog();
  }

  /** 从事件流恢复；重复/坏数据不覆盖已有有效日记。 */
  replayFromLog(): void {
    for (const event of this.log.byType('diary.created')) {
      const payload = event.payload as { diary?: unknown };
      const diary = payload?.diary;
      if (!isDiaryEntry(diary)) continue;
      const key = keyOf(diary.scopeId, diary.dayKey);
      if (!this.entries.has(key)) this.entries.set(key, diary);
    }
  }

  get(scopeId: string, dayKey: string): DiaryEntry | undefined {
    return this.entries.get(keyOf(scopeId, dayKey));
  }

  has(scopeId: string, dayKey: string): boolean {
    return this.entries.has(keyOf(scopeId, dayKey));
  }

  all(): readonly DiaryEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }

  list(query: DiaryQuery = {}): readonly DiaryEntry[] {
    return this.all().filter(
      (d) =>
        (query.sessionId === undefined || d.sessionId === query.sessionId) &&
        (query.userId === undefined || d.userId === query.userId) &&
        (query.dayKey === undefined || d.dayKey === query.dayKey),
    );
  }

  /** 记录一篇日记；同一作用域同一天只允许一篇。 */
  record(entry: DiaryEntry): DiaryEntry {
    const key = keyOf(entry.scopeId, entry.dayKey);
    if (this.entries.has(key)) {
      throw new Error(`diary already exists for ${key}`);
    }
    this.entries.set(key, entry);
    this.log.append({
      type: 'diary.created',
      actor: 'system',
      payload: { diary: entry },
      createdAt: entry.createdAt,
    });
    return entry;
  }

  /** 供测试/重放注入，不发事件。 */
  restore(entry: DiaryEntry): void {
    this.entries.set(keyOf(entry.scopeId, entry.dayKey), entry);
  }

  now(): number {
    return this.clock.now();
  }
}
