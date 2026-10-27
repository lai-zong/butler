/**
 * 周复盘材料 —— 只从日记汇总，不再调用旧反思引擎。
 *
 * ★ 这一层刻意不产生新的候选记忆：
 *   周复盘只负责给出一周发生过什么的摘要；长期记忆仍由每日日记的
 *   试行/转正机制产生。否则每周又会绕过试行，堆出待审候选。
 */

import type { ClockPort } from '../ports/clock.js';
import type { DiaryStore } from './store.js';

export interface WeeklyDiaryDigest {
  readonly candidateCount: 0;
  readonly summary: string;
  readonly usage: { readonly inputTokens: 0; readonly outputTokens: 0 };
}

export function weeklyDiaryDigest(args: {
  readonly diary: DiaryStore;
  readonly clock: ClockPort;
  readonly days?: number;
}): WeeklyDiaryDigest {
  const days = args.days ?? 7;
  const since = args.clock.now() - days * 24 * 60 * 60 * 1000;
  const recent = args.diary
    .all()
    .filter((d) => d.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (recent.length === 0) {
    return {
      candidateCount: 0,
      summary: `最近 ${days} 天没有日记，跳过周复盘。`,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const entries = recent
    .slice(0, 7)
    .map((d) => `- ${d.dayKey}：${d.content.replace(/\s+/g, ' ').slice(0, 220)}（提取 ${d.items.length} 条）`)
    .join('\n');

  return {
    candidateCount: 0,
    summary: `最近 ${days} 天有 ${recent.length} 篇日记；周复盘不新增候选，长期记忆仍走每日试行。\n${entries}`,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
