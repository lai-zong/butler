/**
 * 总览端点 —— 界面首屏、侧栏与「演化」页共用的一份轻量投影
 *
 * ★ 只读、无副作用。它把散在 MemoryStore / SessionStore / EventLog
 *   里的计数一次算清，避免界面为了显示「待审 3 条」而去拉全量数据。
 *
 * ⚠️ 这里**不返回完整聊天内容**（会话列表的摘要最多 90 字）：
 *   首屏不该替用户把全部历史搬进内存。
 */

import { NextResponse } from 'next/server';

import { DATA_DIR, DEFAULT_USER_ID, getRuntime, WORKSPACE_ROOT, eventsFile } from '@/app/runtime';
import {
  computeMemoryStats,
  toEventDto,
  toMemoryDto,
  toSessionDto,
  type EventDto,
  type MemoryDto,
  type SessionDto,
} from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DailyPoint {
  key: string;
  label: string;
  total: number;
  userMessages: number;
  memories: number;
  reflections: number;
  toolCalls: number;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;
  const events = log.all();
  const memories = rt.bootstrapped.memory.all();
  const now = rt.clock.now();

  const sessions: SessionDto[] = rt.bootstrapped.chat
    .listSessions()
    .map((s) =>
      toSessionDto(
        s,
        rt.bootstrapped.chat.messagesOf(s.id),
        rt.bootstrapped.chat.verdictsOf(s.id),
      ),
    );

  const messages = sessions.reduce((n, s) => n + s.messageCount, 0);
  const verdicts = sessions.reduce((n, s) => n + s.verdictCount, 0);

  // ── 近 14 天 ──
  const buckets = new Map<string, DailyPoint>();
  const order: string[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const ts = now - i * DAY_MS;
    const key = dayKey(ts);
    order.push(key);
    buckets.set(key, {
      key,
      label: dayLabel(ts),
      total: 0,
      userMessages: 0,
      memories: 0,
      reflections: 0,
      toolCalls: 0,
    });
  }

  let todayUserMessages = 0;
  let todayVerdicts = 0;
  let todayMemories = 0;
  let accepted = 0;
  let rejected = 0;
  const today = dayKey(now);

  for (const e of events) {
    const key = dayKey(e.createdAt);
    const point = buckets.get(key);
    const p = (typeof e.payload === 'object' && e.payload !== null
      ? e.payload
      : {}) as Record<string, unknown>;

    if (point !== undefined) {
      point.total += 1;
      if (e.type === 'session.message' && p['role'] === 'user') {
        point.userMessages += 1;
        if (key === today) todayUserMessages += 1;
      }
      if (e.type === 'memory.created') {
        point.memories += 1;
        if (key === today) todayMemories += 1;
      }
      if (e.type === 'reflection.done') point.reflections += 1;
      if (e.type === 'tool.call') point.toolCalls += 1;
    }

    if (e.type === 'session.verdict') {
      if (p['outcome'] === 'rejected') rejected += 1;
      else accepted += 1;
      if (key === today) todayVerdicts += 1;
    }
  }

  const daily = order
    .map((k) => buckets.get(k))
    .filter((x): x is DailyPoint => x !== undefined);

  // ── 演化相关的事件 ──
  const evolutionTypes = new Set<string>([
    'memory.created',
    'memory.candidate',
    'memory.approved',
    'memory.rejected',
    'memory.revised',
    'memory.archived',
    'memory.merged',
    'memory.dormant',
    'memory.revived',
    // ⚠️ 刻意排除 `fitness.updated`：它是状态机内部的“字段更新”，
    //    一次建档/命中就可能产生大量同类事件，会把真正的生命周期变化淹没。
    'reflection.done',
    'profile.snapshot',
    'intervention.forgotten',
    'evolution.thresholdAdapted',
  ]);
  const recentEvolution: EventDto[] = events
    .filter((e) => {
      if (!evolutionTypes.has(e.type)) return false;
      /**
       * 建档时也会落 `memory.approved`（`audit: 'created'`），
       * 它与紧邻的 `memory.created` 是同一条事实。演化日志里只保留一次。
       */
      if (e.type === 'memory.approved') {
        const p =
          typeof e.payload === 'object' && e.payload !== null
            ? (e.payload as Record<string, unknown>)
            : {};
        if (p['audit'] === 'created') return false;
      }
      return true;
    })
    .slice(-8)
    .reverse()
    .map(toEventDto);

  const recentEvents: EventDto[] = events.slice(-10).reverse().map(toEventDto);

  // ── 原则 / 聚合记忆 ──
  const principles: MemoryDto[] = memories
    .filter((m) => m.kind === 'principle' && m.lifecycle !== 'archived')
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, 4)
    .map(toMemoryDto);

  const summaries: MemoryDto[] = memories
    .filter((m) => m.kind === 'summary' && m.lifecycle !== 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map(toMemoryDto);

  // ── 行为观察 ──
  const consent = rt.activityObserver.getConsent();
  const observation = {
    granted: consent.granted,
    enabled: consent.enabled,
    grantedAt: consent.grantedAt ?? null,
    retentionDays: consent.retentionDays,
    recordedBlocks: rt.activityObserver.rawRecords().length,
    aggregates: rt.activityObserver.allAggregates().length,
  };

  // ── 练习 ──
  const quizCreated = events.filter((e) => e.type === 'quiz.created').length;
  const gradedEvents = events.filter((e) => e.type === 'quiz.graded');
  const lastGraded = gradedEvents[gradedEvents.length - 1];
  const lastGradedPayload =
    lastGraded !== undefined && typeof lastGraded.payload === 'object' && lastGraded.payload !== null
      ? (lastGraded.payload as Record<string, unknown>)
      : null;
  const quiz = {
    created: quizCreated,
    graded: gradedEvents.length,
    lastScore:
      lastGradedPayload !== null &&
      typeof lastGradedPayload['right'] === 'number' &&
      typeof lastGradedPayload['total'] === 'number'
        ? { right: lastGradedPayload['right'], total: lastGradedPayload['total'] }
        : null,
  };

  const model = rt.model !== null ? rt.model.describe() : null;

  return NextResponse.json({
    ok: true,
    now,
    memory: computeMemoryStats(memories, now),
    sessions,
    totals: {
      sessions: sessions.length,
      messages,
      verdicts,
      accepted,
      rejected,
      events: events.length,
      toolCalls: events.filter((e) => e.type === 'tool.call').length,
      todayUserMessages,
      todayVerdicts,
      todayMemories,
      daysSinceFirstEvent:
        events.length > 0 && events[0] !== undefined
          ? Math.max(0, Math.floor((now - events[0].createdAt) / DAY_MS))
          : 0,
    },
    daily,
    principles,
    summaries,
    recentEvolution,
    recentEvents,
    observation,
    quiz,
    model,
    restoreSummary: rt.restoreSummary,
    diagnostics: {
      sessionId: rt.sessionId,
      userId: DEFAULT_USER_ID,
      startedAt: rt.startedAt,
      uptimeMs: Math.max(0, now - rt.startedAt),
      dataDir: DATA_DIR,
      eventsFile: eventsFile(),
      workspaceRoot: WORKSPACE_ROOT,
      eventsInMemory: log.length,
      pendingPersistence: log.pendingPersistence(),
      resumed: rt.bootstrapped.resumed,
      historicalEvents: rt.bootstrapped.historicalEvents,
      badLines: rt.bootstrapped.badLines,
      issues: rt.bootstrapped.issues.length,
      issueDetails: rt.bootstrapped.issues.slice(0, 8).map((i) => `${i.area}: ${i.detail}`),
      restored: rt.bootstrapped.restored,
      allowWrite: process.env['BUTLER_ALLOW_WRITE'] === '1',
      hasModel: rt.model !== null,
    },
  });
}
