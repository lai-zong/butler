/**
 * 修复旧候选被召回唤醒后重新变成 active 的情况。
 *
 * 只处理曾经被“旧候选迁移”归档、后来因为归档仍可召回而唤醒的记忆。
 */

import { join } from 'node:path';
import { JsonlEventStore, loadEvents } from '../src/adapters/storage/jsonlEvents.js';
import { bootstrap } from '../src/core/runtime/bootstrap.js';
import { FixedClock, SeededRandom } from '../src/core/ports/clock.js';

const file = join(process.cwd(), '.butler-data', 'events.jsonl');
const loaded = await loadEvents(file);
const persistence = new JsonlEventStore({ file, flushIntervalMs: 0 });
const clock = new FixedClock(Date.now());
const b = bootstrap({
  sessionId: 'restore-legacy-archive',
  userId: 'local',
  clock,
  random: new SeededRandom(1),
  historicalEvents: loaded.events,
  badLines: loaded.badLines,
  persistence,
});

const legacyIds = new Set<string>();
for (const event of b.log.byType('memory.archived')) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const reason = typeof p['reason'] === 'string' ? p['reason'] : '';
  const id = typeof p['memoryId'] === 'string' ? p['memoryId'] : '';
  if (id.length > 0 && reason.includes('旧候选迁移')) legacyIds.add(id);
}

const revived = b.memory
  .all()
  .filter((e) => legacyIds.has(e.id) && e.lifecycle !== 'archived');

for (const entry of revived) {
  b.memory.archive(
    entry.id,
    '旧候选迁移恢复：归档仍可召回导致被唤醒；恢复归档，不再进入常规召回。',
  );
}
await b.log.flushPersistence();
console.log(
  JSON.stringify(
    {
      legacyArchivedIds: legacyIds.size,
      restored: revived.map((e) => ({ id: e.id, content: e.content.slice(0, 60) })),
    },
    null,
    2,
  ),
);
