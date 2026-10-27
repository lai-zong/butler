/**
 * 旧候选迁移 —— 只处理重设计之前留下的 candidate。
 *
 * 默认 dry-run；只有 --apply 才写 memory.archived 事件。
 * 迁移原则：旧反思候选没有日记独立证据，且大量是特定任务上下文里的
 * 过拟合原则；不批量转正，统一归档保留，可审计、可回滚数据本身。
 */
import { join } from 'node:path';
import { JsonlEventStore, loadEvents } from '../src/adapters/storage/jsonlEvents.js';
import { bootstrap } from '../src/core/runtime/bootstrap.js';
import { FixedClock, SeededRandom } from '../src/core/ports/clock.js';

const apply = process.argv.includes('--apply');
const file = join(process.cwd(), '.butler-data', 'events.jsonl');
const loaded = await loadEvents(file);
const persistence = new JsonlEventStore({ file, flushIntervalMs: 0 });
const clock = new FixedClock(Date.now());
const b = bootstrap({
  sessionId: 'legacy-candidate-migration',
  userId: 'local',
  clock,
  random: new SeededRandom(1),
  historicalEvents: loaded.events,
  badLines: loaded.badLines,
  ...(apply ? { persistence } : {}),
});

const legacy = b.memory
  .all()
  .filter((e) => e.lifecycle === 'candidate' && !e.evidence.some((x) => x.startsWith('diary:')));

const byKind = legacy.reduce<Record<string, number>>((m, e) => {
  m[e.kind] = (m[e.kind] ?? 0) + 1;
  return m;
}, {});

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  events: loaded.events.length,
  badLines: loaded.badLines,
  candidates: legacy.length,
  byKind,
  samples: legacy.slice(0, 5).map((e) => ({
    id: e.id,
    kind: e.kind,
    confidence: e.confidence,
    evidenceCount: e.evidence.length,
    content: e.content.slice(0, 120),
  })),
}, null, 2));

if (apply) {
  for (const e of legacy) {
    b.memory.archive(
      e.id,
      '旧候选迁移：来自旧反思，缺少独立日记证据，且可能过拟合特定任务；归档保留，不批量转正。',
    );
  }
  await b.log.flushPersistence();
  console.log(`archived ${legacy.length} legacy candidates`);
}
