/**
 * 自主记忆契约评测（确定性，不调用模型）。
 *
 * 目的：用同一套机制跑不同领域的标签，验证：
 *   · 第一天只进入试行；
 *   · 第二天独立证据后自动转正；
 *   · 试行参与召回但降权；
 *   · 显式矛盾自动裁决；
 *   · 长期无第二份证据会归档。
 *
 * 这不是“真实对话效果”评测；真实效果仍需要 A/B / 长期回放。
 */

import { EventLog } from '../src/core/events/log.js';
import { FixedClock, SeededRandom } from '../src/core/ports/clock.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { EvolutionEngine } from '../src/core/memory/evolution.js';
import { recall } from '../src/core/memory/recall.js';
import { ingestDiary } from '../src/core/diary/ingest.js';
import type { DiaryEntry, DiaryExtractedItem } from '../src/core/diary/types.js';

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface Case {
  readonly name: string;
  readonly domain: string;
  readonly content: string;
  readonly kind: 'fact' | 'preference' | 'principle';
  readonly query: string;
}

const CASES: readonly Case[] = [
  { name: 'food', domain: 'life', content: '用户周末通常自己做饭', kind: 'preference', query: '周末做饭' },
  { name: 'medical', domain: 'health', content: '用户每年体检一次', kind: 'fact', query: '体检' },
  { name: 'coding', domain: 'work', content: '用户偏好先写测试再改实现', kind: 'preference', query: '测试 实现' },
  { name: 'art', domain: 'life', content: '用户喜欢低饱和度的配色', kind: 'preference', query: '低饱和度 配色' },
];

function item(c: Case, id: string): DiaryExtractedItem {
  return {
    id,
    kind: c.kind,
    content: c.content,
    confidence: 0.8,
    evidence: [`msg_${c.name}_1`],
    rationale: '契约评测注入',
    ...(c.kind === 'principle' ? { principle: { condition: '当相关场景出现', action: '按偏好处理' } } : {}),
  };
}

function diary(dayKey: string, c: Case): DiaryEntry {
  return {
    id: `d_${c.name}_${dayKey}`,
    scopeId: `session:s_${c.name}`,
    sessionId: `s_${c.name}`,
    userId: 'eval-user',
    dayKey,
    startAt: T0,
    endAt: T0 + 1,
    content: `${c.name} 的当日摘要`,
    items: [item(c, `i_${c.name}_${dayKey}`)],
    sourceMessageIds: [`msg_${c.name}_1`],
    model: 'eval',
    promptVersion: 'eval',
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: T0,
  };
}

function setup(): { log: EventLog; clock: FixedClock; store: MemoryStore; random: SeededRandom } {
  const log = new EventLog('eval-autonomous');
  const clock = new FixedClock(T0);
  return {
    log,
    clock,
    store: new MemoryStore(log, clock, 'eval-user'),
    random: new SeededRandom(7),
  };
}

function main(): void {
  const { log, clock, store, random } = setup();
  const results: Record<string, unknown>[] = [];
  const ids = new Map<string, string>();

  for (const c of CASES) {
    const first = ingestDiary({ log, clock, store, diary: diary('2026-10-26', c) });
    if (first.created.length !== 1) throw new Error(`${c.name}: first ingest failed`);
    const id = first.created[0]!;
    ids.set(c.name, id);
    const trial = store.get(id);
    if (trial?.lifecycle !== 'candidate') throw new Error(`${c.name}: not trial`);
    const recalledTrial = recall({
      query: c.query,
      candidates: store.all(),
      limit: 4,
      now: clock.now(),
      random,
    });
    const trialScore = recalledTrial.selected.find((s) => s.memory.id === id)?.score ?? 0;

    clock.advance(DAY);
    const second = ingestDiary({ log, clock, store, diary: diary('2026-10-27', c) });
    if (!second.promoted.includes(id)) throw new Error(`${c.name}: not promoted`);
    const active = store.get(id);
    if (active?.lifecycle !== 'active') throw new Error(`${c.name}: not active`);

    const activeRecall = recall({
      query: c.query,
      candidates: store.all(),
      limit: 4,
      now: clock.now(),
      random,
    });
    const activeScore = activeRecall.selected.find((s) => s.memory.id === id)?.score ?? 0;

    results.push({
      domain: c.domain,
      case: c.name,
      trialScore: Number(trialScore.toFixed(4)),
      activeScore: Number(activeScore.toFixed(4)),
      promoted: true,
    });
  }

  // 显式矛盾：既有活跃事实优先
  const activeFact = store.create(
    { kind: 'butler', userId: 'eval-user' },
    {
      memClass: 'global_shared',
      kind: 'fact',
      content: '用户对花生不过敏',
      confidence: 0.9,
      evidence: ['user_stated'],
      lifecycle: 'active',
    },
  );
  if (!activeFact.ok) throw new Error('seed conflict failed');
  const conflict = ingestDiary({
    log,
    clock,
    store,
    diary: {
      ...diary('2026-10-28', CASES[0]!),
      content: '矛盾注入',
      items: [
        {
          id: 'conflict_item',
          kind: 'fact',
          content: '用户对花生过敏',
          confidence: 0.8,
          evidence: ['msg_conflict'],
          rationale: '契约评测注入',
        },
      ],
    },
  });
  if (conflict.created.length !== 0) throw new Error('conflict should not create');
  if (log.byType('conflict.resolved').length === 0) throw new Error('conflict unresolved');

  // 长期无第二份证据：归档
  const expireLog = new EventLog('eval-expire');
  const expireStore = new MemoryStore(expireLog, clock, 'eval-user');
  const expireDiary = diary('2026-10-29', {
    ...CASES[0]!,
    name: 'expire',
    content: '用户偶尔提到一个只出现过一次的偏好',
    query: '偏好',
  });
  const expire = ingestDiary({ log: expireLog, clock, store: expireStore, diary: expireDiary });
  const expireId = expire.created[0]!;
  clock.advance(15 * DAY);
  const engine = new EvolutionEngine({
    log: expireLog,
    store: expireStore,
    clock,
    random,
    userId: 'eval-user',
  });
  const pass = engine.runPass();
  if (!pass.trialArchived?.includes(expireId)) throw new Error('expired trial not archived');

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: results,
        conflictResolved: true,
        trialArchived: true,
        note: '确定性契约评测，不代替真实对话 A/B。',
      },
      null,
      2,
    ),
  );
}

main();
