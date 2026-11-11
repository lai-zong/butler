/**
 * 一次性迁移：把旧版 `events.jsonl.bak` 里的记忆导入「记忆存档区」
 *
 * 背景：旧版 `forget` 在抹除前会把整份事件流复制成 `.bak`，于是磁盘上留了
 * 一份"已经删除但原文还在"的历史。现在删除改成两步制，且有了正式的存档区，
 * 这份历史应当被**归档**而不是继续躺在那里。
 *
 * ★ 关键规则（用户确认）：**剔除历史上已经"彻底删除"过的条目**。
 *   那些人当初就是要求销毁的，不能被这次迁移重新复活。
 *
 * 用法：
 *   node --import tsx scripts/migrate-legacy-bak-to-archive.ts           # 预演，只统计
 *   node --import tsx scripts/migrate-legacy-bak-to-archive.ts --apply   # 写入存档并删除 .bak
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonlMemoryArchive } from '../src/adapters/storage/jsonlMemoryArchive.js';
import type { ArchivedMemoryRecord } from '../src/core/memory/archive.js';
import { scrubEventForMemory } from '../src/core/events/scrub.js';
import type { MemoryEntry, SessionEvent } from '../src/core/events/types.js';

const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
/** 支持 `--file=<路径>`：同一套逻辑也用于清理其它旧备份（如 pre-pet-cleanup）。 */
const FILE_ARG = process.argv.find((a) => a.startsWith('--file='));
const BAK = FILE_ARG !== undefined ? FILE_ARG.slice('--file='.length) : join(DATA_DIR, 'events.jsonl.bak');
const EVENTS = join(DATA_DIR, 'events.jsonl');
const APPLY = process.argv.includes('--apply');

function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  const out: SessionEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      out.push(JSON.parse(text) as SessionEvent);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 从事件里取"完整的记忆条目"（不同事件把 entry 放在不同字段）。 */
function entryOf(e: SessionEvent): MemoryEntry | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const raw = p['entry'] ?? p['snapshot'];
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['content'] !== 'string') return null;
  return o as unknown as MemoryEntry;
}

function main(): void {
  if (!existsSync(BAK)) {
    console.log(`[skip] 没有找到 ${BAK}`);
    return;
  }

  const bakEvents = readEvents(BAK);
  const liveEvents = readEvents(EVENTS);

  // 1) 重建"每条记忆最后一个已知状态"（按事件顺序覆盖）
  const latest = new Map<string, MemoryEntry>();
  for (const e of bakEvents) {
    const entry = entryOf(e);
    if (entry !== null) latest.set(entry.id, entry);
  }

  // 2) 已经被"彻底删除"的记忆 id：两边的墓碑都算
  const erased = new Set<string>();
  for (const e of [...bakEvents, ...liveEvents]) {
    if (e.type !== 'intervention.forgotten') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p['erased'] === true && typeof p['memoryId'] === 'string') erased.add(p['memoryId']);
  }

  // 3) 还要排除"当前仍在记忆库里的"——它们没被删，不该进存档区
  const stillLive = new Set<string>();
  for (const e of liveEvents) {
    const entry = entryOf(e);
    if (entry !== null) stillLive.add(entry.id);
    if (e.type === 'intervention.forgotten' || e.type === 'intervention.archivedOut') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (typeof p['memoryId'] === 'string') stillLive.delete(String(p['memoryId']));
    }
  }

  const now = Date.now();
  const records: ArchivedMemoryRecord[] = [];
  let skippedErased = 0;
  let skippedLive = 0;
  let seq = 0;
  for (const entry of latest.values()) {
    if (erased.has(entry.id)) {
      skippedErased += 1;
      continue;
    }
    if (stillLive.has(entry.id)) {
      skippedLive += 1;
      continue;
    }
    seq += 1;
    records.push({
      archiveId: `arc_legacy_${now.toString(36)}_${seq.toString(36)}`,
      memory: entry,
      reason: '旧版本备份迁移（2026-11-11）',
      archivedAt: now,
    });
  }

  console.log('=== 迁移预演 ===');
  console.log('备份事件数        :', bakEvents.length);
  console.log('备份中记忆条数    :', latest.size);
  console.log('跳过·已彻底删除   :', skippedErased);
  console.log('跳过·当前仍在使用 :', skippedLive);
  console.log('将写入存档区      :', records.length);

  // ── 旧事件原文件：抹掉已删除记忆的原文后，作为"历史存档"保留 ──
  //
  //   ⚠️ 只导入记忆条目是 0 条（这份备份里的记忆要么还在用、要么早已彻底删除），
  //      但文件本身还有审计价值（旧会话/旧演化）。所以不丢，而是**抹除后归档**。
  const erasedContent = [...erased]
    .map((id) => ({ id, content: latest.get(id)?.content ?? '' }))
    .filter((x) => x.content.length >= 2);

  let scrubbedLines = 0;
  const legacyLines: string[] = [];
  for (const line of readFileSync(BAK, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    let event: SessionEvent;
    try {
      event = JSON.parse(text) as SessionEvent;
    } catch {
      legacyLines.push(text);
      continue;
    }
    let current = event;
    let changed = false;
    for (const { id, content } of erasedContent) {
      const hit = scrubEventForMemory(current, id, content);
      if (hit !== null) {
        current = hit.event;
        changed = true;
      }
    }
    if (changed) scrubbedLines += 1;
    legacyLines.push(JSON.stringify(current));
  }

  console.log('待抹除的已删除记忆:', erasedContent.length, '条');
  console.log('需要抹除的事件行  :', scrubbedLines);

  if (!APPLY) {
    console.log('\n（预演结束。加 --apply 才会真正写入并删除 .bak）');
    return;
  }

  void (async () => {
    // 1) 记忆条目（本例为 0，逻辑保留以便将来复用）
    const archive = new JsonlMemoryArchive({ dataDir: DATA_DIR });
    for (const r of records) await archive.append(r);

    // 2) 历史事件存档（抹除原文后）
    const legacyDir = join(DATA_DIR, 'archive', 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    const stamp = new Date(now).toISOString().slice(0, 10);
    // 用源文件名做区分，避免同一天两份备份互相覆盖
    const label = (BAK.split(/[\\/]/).pop() ?? 'events')
      .replace(/\.jsonl$/i, '')
      .replace(/[^A-Za-z0-9._-]/g, '_');
    const legacyFile = join(legacyDir, `legacy-events-${stamp}-${label}.jsonl`);
    writeFileSync(legacyFile, legacyLines.join('\n') + '\n', 'utf8');
    writeFileSync(
      join(legacyDir, `legacy-events-${stamp}-${label}.manifest.json`),
      JSON.stringify(
        {
          source: (BAK.split(/[\\/]/).pop() ?? 'events.jsonl.bak'),
          archivedAt: now,
          events: legacyLines.length,
          scrubbedLines,
          erasedMemories: erasedContent.length,
          memoryRecordsImported: records.length,
          note: '旧版本备份的事件流；已抹除"彻底删除"记忆的原文，仅作历史存档',
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('\n✓ 记忆存档写入 :', records.length, '条');
    console.log('✓ 历史事件存档 :', legacyFile, `（${legacyLines.length} 行）`);

    rmSync(BAK, { force: true });
    console.log('✓ 已删除', BAK);
  })();
}

main();
