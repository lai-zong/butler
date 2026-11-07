/**
 * 记忆变化记录 —— 演化页的数据源（只读）
 *
 * 它不是“全量事件流”的另一个入口，而是从事件流里挑出四种真正改变了记忆的
 * 事实，并尽量补上“哪条记忆、为什么、后来怎样”：
 *
 *   · 转正：试行候选被系统/审核通过，进入 active
 *   · 归档：试行到期、审核拒绝或系统归档
 *   · 冲突：两段记忆对同一件事说法不同，以及是否裁决
 *   · 原则：一条原则最近被真正用进任务（按原则聚合，避免刷屏）
 *
 * 与 /api/events 的分工：
 *   /api/events 是原始事实；这里已经是“给人读的变化记录”。
 *   每个变化只带卡片需要的最少字段，不把 payload / agentTrace 铺给界面。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { ACTOR_LABEL } from '@/app/server/uiData.js';
import type { MemoryClass, MemoryEntry, MemoryKind, MemoryLifecycle } from '@/core/memory/types.js';
import type { SessionEvent } from '@/core/events/types.js';
import type {
  MemoryChange,
  MemoryChangeConflict,
  MemoryChangeCounts,
  MemoryChangeKind,
  MemoryChangeMemory,
  MemoryChangePrinciple,
  MemoryChangesResponse,
} from '@/app/ui/lib/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LIMIT = 120;
const DEFAULT_LIMIT = 80;
const DAY_MS = 86_400_000;

type Payload = Record<string, unknown>;

interface SnapshotMemory {
  readonly id: string;
  readonly subject?: string;
  readonly content: string;
  readonly lifecycle: MemoryLifecycle;
  readonly kind: MemoryKind;
  readonly memClass: MemoryClass;
  readonly domain?: string;
  readonly fitness?: number;
  readonly confidence?: number;
  readonly version?: number;
}

interface PromotionSeed {
  readonly at: number;
  readonly seq: number;
  readonly memoryId: string;
  readonly actor: string;
  readonly reason: string;
  readonly audit: string;
  readonly snapshot: SnapshotMemory | null;
}

interface ArchiveSeed {
  readonly at: number;
  readonly seq: number;
  readonly memoryId: string;
  readonly actor: string;
  readonly reason: string;
  readonly rejected: boolean;
  readonly snapshot: SnapshotMemory | null;
}

interface ConflictSeed {
  readonly at: number;
  readonly seq: number;
  readonly actor: string;
  readonly candidateId: string | null;
  readonly existingId: string | null;
  readonly candidateContent: string | null;
  readonly existingContent: string | null;
  readonly reason: string;
}

interface ResolvedSeed {
  readonly at: number;
  readonly seq: number;
  readonly actor: string;
  readonly candidateId: string | null;
  readonly existingId: string | null;
  readonly winner: 'new' | 'existing' | null;
  readonly winnerId: string | null;
  readonly loserId: string | null;
  readonly reason: string;
}

interface PrincipleGroup {
  memoryId: string;
  applications: number;
  appliedTotal: number;
  lastAt: number;
  lastSeq: number;
  lastActor: string;
  lastTaskId: string;
  content: string;
  condition: string | null;
  action: string | null;
  memClass: MemoryClass | null;
  why: string;
}

interface EffectSeed {
  readonly at: number;
  readonly effective: boolean;
  readonly note: string | null;
  readonly taskId: string;
}

function payloadOf(event: SessionEvent): Payload {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Payload)
    : {};
}

function str(p: Payload, key: string): string {
  const value = p[key];
  return typeof value === 'string' ? value : '';
}

function num(p: Payload, key: string): number | null {
  const value = p[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isLifecycle(value: string): value is MemoryLifecycle {
  return value === 'candidate' || value === 'active' || value === 'dormant' || value === 'archived';
}

function isKind(value: string): value is MemoryKind {
  return value === 'fact' || value === 'preference' || value === 'principle' || value === 'summary';
}

function isMemClass(value: string): value is MemoryClass {
  return (
    value === 'global_constraint' ||
    value === 'global_shared' ||
    value === 'sensitive' ||
    value === 'domain'
  );
}

function snapshotOf(value: unknown): SnapshotMemory | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Payload;
  const id = str(p, 'id');
  const content = str(p, 'content');
  const lifecycle = str(p, 'lifecycle');
  const kind = str(p, 'kind');
  const memClass = str(p, 'memClass');
  if (
    id.length === 0 ||
    content.length === 0 ||
    !isLifecycle(lifecycle) ||
    !isKind(kind) ||
    !isMemClass(memClass)
  ) {
    return null;
  }
  const subject = str(p, 'subject');
  const domain = str(p, 'domain');
  const fitness = num(p, 'fitness');
  const confidence = num(p, 'confidence');
  const version = num(p, 'version');
  return {
    id,
    content,
    lifecycle,
    kind,
    memClass,
    ...(subject.length > 0 ? { subject } : {}),
    ...(domain.length > 0 ? { domain } : {}),
    ...(fitness !== null ? { fitness } : {}),
    ...(confidence !== null ? { confidence } : {}),
    ...(version !== null ? { version } : {}),
  };
}

function snapshotOfEntry(entry: MemoryEntry | undefined): SnapshotMemory | null {
  if (entry === undefined) return null;
  return {
    id: entry.id,
    content: entry.content,
    lifecycle: entry.lifecycle,
    kind: entry.kind,
    memClass: entry.memClass,
    ...(entry.subject !== undefined && entry.subject.length > 0 ? { subject: entry.subject } : {}),
    ...(entry.domain !== undefined ? { domain: entry.domain } : {}),
    fitness: entry.fitness,
    confidence: entry.confidence,
    version: entry.version,
  };
}

function toMemoryDto(snapshot: SnapshotMemory): MemoryChangeMemory {
  return {
    id: snapshot.id,
    subject: snapshot.subject ?? null,
    content: snapshot.content,
    lifecycle: snapshot.lifecycle,
    kind: snapshot.kind,
    memClass: snapshot.memClass,
    domain: snapshot.domain ?? null,
    fitness: snapshot.fitness ?? 0,
    confidence: snapshot.confidence ?? 0,
    version: snapshot.version ?? 1,
  };
}

function actorLabel(actor: string): string {
  return ACTOR_LABEL[actor] ?? actor;
}

/** 归档快照通常没有 subject；用第一句内容做标题，避免所有卡片都叫“一条旧记忆”。 */
function contentHeadline(content: string): string {
  const trimmed = content.trim();
  const first = trimmed.split(/[。！？\n]/)[0]?.trim() ?? '';
  const text = first.length > 0 ? first : trimmed;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

function conflictKey(candidateId: string, memoryId: string): string | null {
  if (candidateId.length > 0) return `candidate:${candidateId}`;
  if (memoryId.length > 0) return `memory:${memoryId}`;
  return null;
}

export async function GET(req: Request): Promise<NextResponse<MemoryChangesResponse>> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const log = rt.bootstrapped.log;

  const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  const promotions = new Map<string, PromotionSeed>();
  const archives = new Map<string, ArchiveSeed>();
  const detectedConflicts = new Map<string, ConflictSeed>();
  const resolvedConflicts = new Map<string, ResolvedSeed>();
  const principleGroups = new Map<string, PrincipleGroup>();
  const effects = new Map<string, EffectSeed>();

  for (const event of log.all()) {
    const p = payloadOf(event);

    if (event.type === 'memory.approved') {
      const audit = str(p, 'audit');
      if (audit !== 'probationPromotion' && audit !== 'review') continue;
      const memoryId = str(p, 'memoryId');
      if (memoryId.length === 0) continue;
      promotions.set(memoryId, {
        at: event.createdAt,
        seq: event.seq,
        memoryId,
        actor: event.actor,
        reason: str(p, 'reason'),
        audit,
        snapshot: snapshotOf(p['snapshot']) ?? snapshotOfEntry(store.get(memoryId)),
      });
      continue;
    }

    if (event.type === 'memory.archived' || event.type === 'memory.rejected') {
      const memoryId = str(p, 'memoryId');
      if (memoryId.length === 0) continue;
      archives.set(memoryId, {
        at: event.createdAt,
        seq: event.seq,
        memoryId,
        actor: event.actor,
        reason: str(p, 'reason'),
        rejected: event.type === 'memory.rejected',
        snapshot: snapshotOf(p['snapshot']) ?? snapshotOfEntry(store.get(memoryId)),
      });
      continue;
    }

    if (event.type === 'conflict.detected' || event.type === 'conflict.resolved') {
      const candidateId = str(p, 'candidateId');
      const memoryId = str(p, 'memoryId');
      const key = conflictKey(candidateId, memoryId);
      if (key === null) continue;

      if (event.type === 'conflict.detected') {
        const candidateContent = str(p, 'candidateContent') || store.get(candidateId)?.content || null;
        const existingContent = str(p, 'existingContent') || store.get(memoryId)?.content || null;
        detectedConflicts.set(key, {
          at: event.createdAt,
          seq: event.seq,
          actor: event.actor,
          candidateId: candidateId.length > 0 ? candidateId : null,
          existingId: memoryId.length > 0 ? memoryId : null,
          candidateContent,
          existingContent,
          reason: str(p, 'reason'),
        });
      } else {
        const winner = str(p, 'winner');
        resolvedConflicts.set(key, {
          at: event.createdAt,
          seq: event.seq,
          actor: event.actor,
          candidateId: candidateId.length > 0 ? candidateId : null,
          existingId: memoryId.length > 0 ? memoryId : null,
          winner: winner === 'new' || winner === 'existing' ? winner : null,
          winnerId: str(p, 'winnerId') || null,
          loserId: str(p, 'loserId') || null,
          reason: str(p, 'reason'),
        });
      }
      continue;
    }

    if (event.type === 'principle.applied') {
      const memoryId = str(p, 'memoryId');
      if (memoryId.length === 0) continue;
      const existing = principleGroups.get(memoryId);
      const appliedTotal = num(p, 'appliedTotal') ?? 0;
      if (existing === undefined) {
        principleGroups.set(memoryId, {
          memoryId,
          applications: 1,
          appliedTotal,
          lastAt: event.createdAt,
          lastSeq: event.seq,
          lastActor: event.actor,
          lastTaskId: str(p, 'taskId'),
          content: str(p, 'content'),
          condition: str(p, 'condition') || null,
          action: str(p, 'action') || null,
          memClass: isMemClass(str(p, 'memClass')) ? (str(p, 'memClass') as MemoryClass) : null,
          why: str(p, 'why'),
        });
      } else {
        existing.applications += 1;
        existing.appliedTotal = Math.max(existing.appliedTotal, appliedTotal);
        if (event.createdAt >= existing.lastAt) {
          existing.lastAt = event.createdAt;
          existing.lastSeq = event.seq;
          existing.lastActor = event.actor;
          existing.lastTaskId = str(p, 'taskId');
          existing.content = str(p, 'content') || existing.content;
          existing.condition = str(p, 'condition') || existing.condition;
          existing.action = str(p, 'action') || existing.action;
          existing.memClass = isMemClass(str(p, 'memClass'))
            ? (str(p, 'memClass') as MemoryClass)
            : existing.memClass;
          existing.why = str(p, 'why') || existing.why;
        }
      }
      continue;
    }

    if (event.type === 'principle.effectMeasured') {
      const memoryId = str(p, 'memoryId');
      if (memoryId.length === 0) continue;
      const previous = effects.get(memoryId);
      if (previous === undefined || event.createdAt >= previous.at) {
        effects.set(memoryId, {
          at: event.createdAt,
          effective: p['effective'] === true,
          note: str(p, 'note') || null,
          taskId: str(p, 'taskId'),
        });
      }
    }
  }

  const changes: MemoryChange[] = [];

  for (const seed of promotions.values()) {
    const memory = seed.snapshot === null ? null : toMemoryDto(seed.snapshot);
    changes.push({
      id: `promotion-${seed.memoryId}-${seed.seq}`,
      seq: seed.seq,
      at: seed.at,
      kind: 'promotion',
      title:
        memory === null
          ? '一条试行记忆'
          : (memory.subject ?? contentHeadline(memory.content)),
      summary:
        seed.audit === 'probationPromotion'
          ? '它在试行期里攒够了独立证据，从试行转正。'
          : '审核通过，它从试行进入活跃。',
      note: seed.reason.length > 0 ? seed.reason : null,
      actor: seed.actor,
      actorLabel: actorLabel(seed.actor),
      memory,
      transition: { from: 'candidate', to: 'active' },
      conflict: null,
      principle: null,
    });
  }

  for (const seed of archives.values()) {
    const memory = seed.snapshot === null ? null : toMemoryDto(seed.snapshot);
    const trial = seed.rejected || seed.reason.includes('试行');
    changes.push({
      id: `archive-${seed.memoryId}-${seed.seq}`,
      seq: seed.seq,
      at: seed.at,
      kind: 'archive',
      title:
        memory === null
          ? '一条旧记忆'
          : (memory.subject ?? contentHeadline(memory.content)),
      summary: seed.rejected
        ? '没有通过审核，它被收进归档。'
        : trial
          ? '试行期结束，没有等到足够证据，它被收进归档。'
          : '它退到归档，不再主动出现在日常对话里。',
      note: seed.reason.length > 0 ? seed.reason : null,
      actor: seed.actor,
      actorLabel: actorLabel(seed.actor),
      memory,
      transition: { from: trial ? 'candidate' : null, to: 'archived' },
      conflict: null,
      principle: null,
    });
  }

  const conflictKeys = new Set<string>([
    ...detectedConflicts.keys(),
    ...resolvedConflicts.keys(),
  ]);
  for (const key of conflictKeys) {
    const detected = detectedConflicts.get(key) ?? null;
    const resolved = resolvedConflicts.get(key) ?? null;
    const at = resolved?.at ?? detected?.at;
    if (at === undefined) continue;

    const candidateId = detected?.candidateId ?? resolved?.candidateId ?? null;
    const existingId = detected?.existingId ?? resolved?.existingId ?? null;
    const fallbackId = resolved?.winnerId ?? resolved?.loserId ?? null;
    const candidateContent =
      detected?.candidateContent ??
      (candidateId !== null ? store.get(candidateId)?.content ?? null : null);
    const existingContent =
      detected?.existingContent ??
      (existingId !== null ? store.get(existingId)?.content ?? null : null);
    const primaryId = existingId ?? candidateId ?? fallbackId;
    const primary = primaryId !== null ? snapshotOfEntry(store.get(primaryId)) : null;
    const memory = primary === null ? null : toMemoryDto(primary);
    const subject = memory?.subject ?? null;
    const resolvedWinner = resolved?.winner ?? null;
    const winnerContent =
      resolvedWinner === 'new'
        ? candidateContent
        : resolvedWinner === 'existing'
          ? existingContent
          : null;
    const loserContent =
      resolvedWinner === 'new'
        ? existingContent
        : resolvedWinner === 'existing'
          ? candidateContent
          : null;
    const conflict: MemoryChangeConflict = {
      candidateContent,
      existingContent,
      candidateId,
      existingId,
      resolved: resolved !== null,
      winner: resolvedWinner,
      winnerContent,
      loserContent,
      detectedAt: detected?.at ?? resolved?.at ?? at,
      resolvedAt: resolved?.at ?? null,
    };
    const reason = resolved?.reason || detected?.reason || '';

    changes.push({
      id: `conflict-${key}`,
      seq: resolved?.seq ?? detected?.seq ?? 0,
      at,
      kind: 'conflict',
      title: subject === null ? '一次说法冲突' : `关于「${subject}」的冲突`,
      summary:
        resolved === null
          ? '两段记忆对同一件事说法不同，还没有裁决。'
          : resolvedWinner === 'new'
            ? '两段记忆对同一件事说法不同，最后留下了新的说法。'
            : resolvedWinner === 'existing'
              ? '两段记忆对同一件事说法不同，最后留下了原来的说法。'
              : '两段记忆对同一件事说法不同，已经做过裁决。',
      note: reason.length > 0 ? reason : null,
      actor: resolved?.actor ?? detected?.actor ?? 'system',
      actorLabel: actorLabel(resolved?.actor ?? detected?.actor ?? 'system'),
      memory,
      transition: null,
      conflict,
      principle: null,
    });
  }

  for (const group of principleGroups.values()) {
    const entry = store.get(group.memoryId);
    const snapshot = snapshotOfEntry(entry);
    const memory = snapshot === null ? null : toMemoryDto(snapshot);
    const title =
      memory?.subject ??
      (group.content.length > 0 ? group.content : '一条原则');
    const effect = effects.get(group.memoryId) ?? null;
    const principle: MemoryChangePrinciple = {
      condition: group.condition,
      action: group.action,
      applied: group.applications,
      appliedTotal: Math.max(
        group.appliedTotal,
        group.applications,
        entry?.effectiveness?.applied ?? 0,
      ),
      effective: effect === null ? null : effect.effective,
      effectNote: effect?.note ?? null,
    };

    changes.push({
      id: `principle-${group.memoryId}`,
      seq: group.lastSeq,
      at: group.lastAt,
      kind: 'principle',
      title,
      summary:
        group.applications > 1
          ? `它累计被用上 ${group.applications} 次。`
          : '在一次任务里，它按这条原则做了决定。',
      note: effect?.note ?? (group.why.length > 0 ? group.why : null),
      actor: group.lastActor,
      actorLabel: actorLabel(group.lastActor),
      memory,
      transition: null,
      conflict: null,
      principle,
    });
  }

  changes.sort((a, b) => b.at - a.at || b.seq - a.seq);
  const visible = changes.slice(0, limit);
  const tally: Record<MemoryChangeKind, number> = {
    promotion: 0,
    archive: 0,
    conflict: 0,
    principle: 0,
  };
  let applications = 0;
  for (const change of visible) {
    tally[change.kind] += 1;
    if (change.principle !== null) applications += change.principle.applied;
  }
  const counts: MemoryChangeCounts = { ...tally, total: visible.length };
  const from = visible.length > 0 ? visible[visible.length - 1]!.at : null;
  const to = visible.length > 0 ? visible[0]!.at : null;
  let days = 0;
  if (from !== null && to !== null) {
    const start = new Date(from);
    const end = new Date(to);
    const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    days = Math.max(1, Math.round((endDay - startDay) / DAY_MS) + 1);
  }

  return NextResponse.json({
    ok: true,
    changes: visible,
    counts,
    applications,
    window: {
      from,
      to,
      days,
    },
    truncated: changes.length > visible.length,
  });
}
