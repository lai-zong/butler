/**
 * 遗忘权的**事件载荷抹除**（与重放配合，保证"删除过就不复活"）。
 *
 * ★ 为什么需要它：
 *   `intervention.forgotten` 只说明"这条记忆被删了"，但更早的
 *   `memory.created` / `memory.revised` / `fitness.updated` 里仍然可能
 *   带着原文。如果只删内存状态，重启重放会把内容装回来，审计页也能看到 ——
 *   这与"彻底删除"的承诺不符。
 *
 * ★ 边界（写清楚，避免误以为它擦除了整个世界）：
 *   · 只处理**引用了该 memoryId** 的事件（created/revised/fitness/授权使用等）；
 *   · 另外兜底替换包含完整原文的字段（防止某些事件只带内容不带 id）；
 *   · 聊天记录里用户/管家复述过的同一句话**不在这里处理** —— 那是另一份历史，
 *     不属于"记忆条目"的载荷。
 */

import type { SessionEvent } from './types.js';

/** 抹除后的占位符。审计页会显示它，表示"这里曾经有内容"。 */
export const FORGOTTEN_PLACEHOLDER = '[已遗忘]';

/**
 * 内容指纹（FNV-1a 32 位）。
 *
 * ⚠️ 刻意不用 crypto：核心层不依赖 Node 内置模块；
 *    这里只需要"能证明曾经有过这段内容"，不需要密码学强度。
 */
export function hashContent(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 事件载荷里是否引用了这个 memoryId（对象任意层级）。 */
export function referencesMemory(value: unknown, memoryId: string, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return value === memoryId;
  if (Array.isArray(value)) return value.some((v) => referencesMemory(v, memoryId, depth + 1));
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'memoryId' || k === 'id' || k === 'memoryID') && v === memoryId) return true;
      if (referencesMemory(v, memoryId, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * 深度替换：把 `content` 出现的字符串字段改成占位符。 * 返回**新对象**（不修改入参）；没有命中时返回原对象以减少复制。
 */
function scrubValue(
  value: unknown,
  content: string,
  stats: { fields: number },
  depth = 0,
): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    if (content.length >= 2 && value.includes(content)) {
      stats.fields += 1;
      return value.split(content).join(FORGOTTEN_PLACEHOLDER);
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = scrubValue(v, content, stats, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = scrubValue(v, content, stats, depth + 1);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * 处理一条事件：引用该记忆、或包含原文时，抹除内容。
 *
 * 返回 null 表示"这条事件不需要改"。
 */
export function scrubEventForMemory(
  event: SessionEvent,
  memoryId: string,
  content: string,
): { readonly event: SessionEvent; readonly fields: number } | null {
  if (content.length < 2 && !referencesMemory(event.payload, memoryId)) return null;

  const referenced = referencesMemory(event.payload, memoryId);
  const stats = { fields: 0 };
  const nextPayload = scrubValue(event.payload, content, stats);

  if (stats.fields === 0 && !referenced) return null;
  if (nextPayload === event.payload) return null;

  return {
    event: { ...event, payload: nextPayload },
    fields: stats.fields,
  };
}

/**
 * 从事件流里找出某条记忆最后一次出现的内容（用于旧数据迁移）。
 *
 * 取**最早**的 created/状态快照里的 content：
 * 越早越接近原文；后续事件可能是修订后的文本。
 */
export function findMemoryContent(
  events: readonly SessionEvent[],
  memoryId: string,
): string | undefined {
  for (const e of events) {
    const payload = e.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const entry =
      typeof p['entry'] === 'object' && p['entry'] !== null
        ? (p['entry'] as Record<string, unknown>)
        : undefined;
    if (entry !== undefined && entry['id'] === memoryId && typeof entry['content'] === 'string') {
      return entry['content'];
    }
    const snapshot =
      typeof p['snapshot'] === 'object' && p['snapshot'] !== null
        ? (p['snapshot'] as Record<string, unknown>)
        : undefined;
    if (
      snapshot !== undefined &&
      snapshot['id'] === memoryId &&
      typeof snapshot['content'] === 'string'
    ) {
      return snapshot['content'];
    }
  }
  return undefined;
}
