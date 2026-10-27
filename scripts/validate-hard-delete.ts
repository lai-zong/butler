/**
 * 硬约束删除 + 重启重放验证。
 */

import { EventLog } from '../src/core/events/log.js';
import { FixedClock } from '../src/core/ports/clock.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { replayMemory } from '../src/core/memory/replay.js';

const T0 = 1_760_000_000_000;
const clock = new FixedClock(T0);
const log = new EventLog('validate-hard-delete');
const store = new MemoryStore(log, clock, 'u1');

const created = store.create(
  { kind: 'user', userId: 'u1' },
  {
    memClass: 'global_constraint',
    kind: 'fact',
    content: '用户对花生严重过敏。',
    confidence: 1,
    evidence: ['user_stated'],
    lifecycle: 'active',
  },
);
if (!created.ok) throw new Error('create failed');
const id = created.entry.id;

const before = store.get(id) !== undefined;
const deleted = store.forgetHardConstraint({ kind: 'user', userId: 'u1' }, id, 'confirmed');
const after = store.get(id) === undefined;
const replayed = replayMemory(log.all());
const replayHas = replayed.entries.some((e) => e.id === id);
const tomb = log.byType('intervention.forgotten').at(-1);
const tombText = JSON.stringify(tomb?.payload ?? {});
const contentLeaked = tombText.includes('花生');

console.log(
  JSON.stringify(
    {
      before,
      deleted: deleted.ok,
      after,
      replayHas,
      tombstone: tomb?.payload,
      contentLeaked,
      ok: before && deleted.ok && after && !replayHas && !contentLeaked,
    },
    null,
    2,
  ),
);
