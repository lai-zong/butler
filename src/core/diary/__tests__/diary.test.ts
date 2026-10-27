import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelPort } from '../../ports/model.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore } from '../../chat/types.js';
import { DiaryStore } from '../store.js';
import { dayKeyFor, dayWindow, previousDayKey } from '../time.js';
import { generateDiary } from '../generate.js';
import { ingestDiary, DIARY_EVIDENCE_PREFIX } from '../ingest.js';
import { diaryWorthy, runDailyDiaries } from '../pipeline.js';
import type { DiaryModelOutput } from '../schema.js';
import type { DiaryEntry, DiarySourceMessage } from '../types.js';


function makeModel(output: DiaryModelOutput, seen: string[] = []): ModelPort {
  return {
    describe: () => ({
      provider: 'test',
      model: 'fake-memory',
      capabilities: {
        supportsVision: false,
        supportsStreaming: false,
        supportsTools: false,
        supportsThinking: false,
      },
    }),
    complete: async () => {
      throw new Error('diary should use completeStructured');
    },
    completeStructured: async (call) => {
      seen.push(JSON.stringify(call.messages));
      return { value: output, usage: { inputTokens: 12, outputTokens: 8 }, attempts: 1 };
    },
  } as ModelPort;
}

function setup(): {
  log: EventLog;
  clock: FixedClock;
  chat: SessionStore;
  memory: MemoryStore;
  store: MemoryStore;
  diary: DiaryStore;
} {
  const log = new EventLog('s_diary');
  const clock = new FixedClock(new Date(2026, 9, 28, 12, 0, 0).getTime());
  const chat = new SessionStore(log, clock, 'u1');
  const memory = new MemoryStore(log, clock, 'u1');
  const diary = new DiaryStore(log, clock);
  return { log, clock, chat, memory, store: memory, diary };
}

function append(
  chat: SessionStore,
  clock: FixedClock,
  sessionId: string,
  at: number,
  role: 'user' | 'butler',
  text: string,
): string {
  clock.advance(at - clock.now());
  const m = chat.appendMessage(sessionId, { role, text, status: 'done' });
  return m.id;
}

describe('diary day boundary', () => {
  it('is deterministic around 04:00 local time', () => {
    const before = new Date(2026, 9, 28, 3, 59, 0).getTime();
    const after = new Date(2026, 9, 28, 4, 0, 0).getTime();
    expect(dayKeyFor(before)).toBe('2026-10-27');
    expect(dayKeyFor(after)).toBe('2026-10-28');
    const w = dayWindow('2026-10-27');
    expect(w.startAt).toBe(new Date(2026, 9, 27, 4, 0, 0).getTime());
    expect(w.endAt).toBe(new Date(2026, 9, 28, 4, 0, 0).getTime());
    expect(previousDayKey(new Date(2026, 9, 28, 12, 0, 0).getTime())).toBe('2026-10-27');
  });
});

describe('diary store', () => {
  it('replays diary.created without duplicating entries', async () => {
    const { log, clock, chat, diary } = setup();
    const session = chat.latestOrCreate();
    const at = new Date(2026, 9, 27, 10, 0, 0).getTime();
    const id1 = append(chat, clock, session.id, at, 'user', '我想记住这件事');
    const id2 = append(chat, clock, session.id, at + 1000, 'butler', '好');

    const messages: DiarySourceMessage[] = [
      { id: id1, role: 'user', text: '我想记住这件事', createdAt: at },
      { id: id2, role: 'butler', text: '好', createdAt: at + 1000 },
    ];
    const generated = await generateDiary({
      model: makeModel({
        diary: '今天用户让我记住一件事。',
        items: [
          {
            kind: 'fact',
            content: '用户希望记住这件事',
            confidence: 0.8,
            evidence: [id1],
          },
        ],
      }),
      clock,
      sessionId: session.id,
      userId: 'u1',
      dayKey: '2026-10-27',
      messages,
      minUserMessages: 1,
    });

    diary.record(generated.entry);
    expect(diary.all()).toHaveLength(1);
    expect(log.byType('diary.created')).toHaveLength(1);

    const replay = new DiaryStore(log, clock);
    expect(replay.all()).toHaveLength(1);
    expect(replay.get(`session:${session.id}`, '2026-10-27')?.items[0]?.content).toContain('记住');
  });
});

describe('diary generation', () => {
  it('drops items without valid message evidence and requires principle condition/action', async () => {
    const { clock, chat } = setup();
    const session = chat.latestOrCreate();
    const at = new Date(2026, 9, 27, 10, 0, 0).getTime();
    const id1 = append(chat, clock, session.id, at, 'user', '我更喜欢先看结论');
    const messages: DiarySourceMessage[] = [
      { id: id1, role: 'user', text: '我更喜欢先看结论', createdAt: at },
    ];
    const r = await generateDiary({
      model: makeModel({
        diary: '用户说更喜欢先看结论。',
        items: [
          {
            kind: 'preference',
            content: '用户希望先看结论',
            confidence: 0.7,
            evidence: [id1],
          },
          {
            kind: 'fact',
            content: '无来源的条目',
            confidence: 0.9,
            evidence: ['msg_missing'],
          },
          {
            kind: 'principle',
            content: '回答先给结论',
            confidence: 0.7,
            evidence: [id1],
          },
        ],
      }),
      clock,
      sessionId: session.id,
      userId: 'u1',
      dayKey: '2026-10-27',
      messages,
      minUserMessages: 1,
    });

    expect(r.entry.items).toHaveLength(2);
    expect(r.entry.items[0]?.kind).toBe('preference');
    expect(r.entry.items[1]?.kind).toBe('preference');
    expect(r.entry.items[1]?.confidence).toBeLessThanOrEqual(0.55);
  });
});

function entry(dayKey: string, content: string, confidence = 0.8): DiaryEntry {
  return {
    id: `diary_test_${dayKey}`,
    scopeId: 'session:s1',
    sessionId: 's1',
    userId: 'u1',
    dayKey,
    startAt: 0,
    endAt: 1,
    content: 'test diary',
    sourceMessageIds: ['m1'],
    items: [
      {
        id: `diary_test_${dayKey}_item_0`,
        kind: 'fact',
        content,
        confidence,
        evidence: ['m1'],
        rationale: 'test',
      },
    ],
    model: 'fake-memory',
    promptVersion: 'diary.v1',
    usage: { inputTokens: 1, outputTokens: 1 },
    createdAt: 1,
  };
}

describe('diary ingest', () => {
  it('creates trial candidates and promotes only after independent days', () => {
    const { log, clock, store } = setup();
    const first = ingestDiary({
      log,
      clock,
      store,
      diary: entry('2026-10-26', '用户喜欢先看结论', 0.7),
    });
    expect(first.created).toHaveLength(1);
    expect(first.promoted).toHaveLength(0);
    const id = first.created[0]!;
    expect(store.get(id)?.lifecycle).toBe('candidate');
    expect(store.get(id)?.evidence).toContain(`${DIARY_EVIDENCE_PREFIX}2026-10-26`);

    // 同一天重复日记不会制造第二条节点。
    const sameDay = ingestDiary({
      log,
      clock,
      store,
      diary: entry('2026-10-26', '用户喜欢先看结论', 0.7),
    });
    expect(sameDay.created).toHaveLength(0);
    expect(store.size()).toBe(1);

    const secondDay = ingestDiary({
      log,
      clock,
      store,
      diary: entry('2026-10-27', '用户喜欢先看结论', 0.75),
    });
    expect(secondDay.promoted).toEqual([id]);
    expect(store.get(id)?.lifecycle).toBe('active');
    expect(store.get(id)?.evidence).toContain(`${DIARY_EVIDENCE_PREFIX}2026-10-27`);
  });

  it('does not auto-promote an old review candidate without diary evidence', () => {
    const { log, clock, store } = setup();
    const old = store.create(
      { kind: 'butler', userId: 'u1' },
      {
        memClass: 'global_shared',
        kind: 'fact',
        content: '用户喜欢先看结论',
        confidence: 0.8,
        evidence: ['old_review'],
        lifecycle: 'candidate',
      },
    );
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error('seed failed');
    const r = ingestDiary({
      log,
      clock,
      store,
      diary: entry('2026-10-27', '用户喜欢先看结论', 0.8),
    });
    expect(r.promoted).toHaveLength(0);
    expect(store.get(old.entry.id)?.lifecycle).toBe('candidate');
  });
});

describe('daily diary pipeline', () => {
  it('skips sessions with fewer than four user messages, then creates one diary', async () => {
    const { log, clock, chat, memory, diary } = setup();
    const session = chat.latestOrCreate();
    const at = new Date(2026, 9, 27, 10, 0, 0).getTime();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(append(chat, clock, session.id, at + i * 1000, 'user', `消息 ${i}`));
    }
    const seen: string[] = [];
    const model = makeModel(
      {
        diary: '这些消息还不足以形成完整的一天。',
        items: [],
      },
      seen,
    );

    const first = await runDailyDiaries({
      model,
      log,
      clock,
      chat,
      diary,
      memory,
      dayKey: '2026-10-27',
    });
    expect(first.created).toBe(0);
    expect(seen).toHaveLength(0);

    for (let i = 3; i < 5; i += 1) {
      ids.push(append(chat, clock, session.id, at + i * 1000, 'user', `消息 ${i}`));
    }
    const second = await runDailyDiaries({
      model: makeModel(
        {
          diary: '用户今天连续讨论了五件事。',
          items: [
            {
              kind: 'fact',
              content: '用户今天讨论了五件事',
              confidence: 0.8,
              evidence: [ids[0]!, ids[1]!],
            },
          ],
        },
        seen,
      ),
      log,
      clock,
      chat,
      diary,
      memory,
      dayKey: '2026-10-27',
    });
    expect(second.created).toBe(1);
    expect(diary.all()).toHaveLength(1);
    expect(memory.size()).toBe(1);
    expect(memory.all()[0]?.lifecycle).toBe('candidate');
    expect(seen).toHaveLength(1);

    const third = await runDailyDiaries({
      model,
      log,
      clock,
      chat,
      diary,
      memory,
      dayKey: '2026-10-27',
    });
    expect(third.created).toBe(0);
    expect(third.skipped).toBe(1);
  });

  it('counts only completed/interrupted messages and requires user content', () => {
    const messages: DiarySourceMessage[] = [
      { id: 'a', role: 'user', text: '一', createdAt: 1 },
      { id: 'b', role: 'user', text: '二', createdAt: 2 },
      { id: 'c', role: 'user', text: '', createdAt: 3 },
      { id: 'd', role: 'user', text: '四', createdAt: 4 },
    ];
    expect(diaryWorthy(messages, 4)).toBe(false);
    expect(diaryWorthy(messages, 3)).toBe(true);
  });
});
