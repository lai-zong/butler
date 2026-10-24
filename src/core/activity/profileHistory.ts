/**
 * 画像快照历史 —— 从事件流读回「成长对比」所需的完整快照。
 *
 * 设计依据：方案 § 3.3（成长对比，最强演示件）、§ 4.1（事件是唯一真相源）
 *
 * ★ 为什么需要单独一层：
 *   `captureProfile` 负责「算 + 写事件」，但界面要的是「列出历史快照」与
 *   「任意两份快照的 diff」。这两件事都不该写在 Route Handler 里：
 *     · 事件 payload 是跨持久化边界的数据，属于不可信输入，必须校验；
 *     · 校验 + 排序 + 去重是纯函数，可以单测、可以重放。
 *
 * ⚠️ 兼容旧数据：
 *   v10.1 之前的 `profile.snapshot` 只写计数，没有 `snapshot` 字段。
 *   这些事件不是"错误数据"，只是**信息不足**——跳过并计数，由界面决定
 *   是否提示"旧快照不可对比"，不伪造、不猜。
 */

import type { SessionEvent } from '../events/types.js';
import type { ProfileSnapshot } from './profile.js';

export interface ProfileHistory {
  /** 按 capturedAt 升序、同 id 去重后的完整快照 */
  readonly profiles: readonly ProfileSnapshot[];
  /** 旧版本（只有计数）或结构损坏、无法重建的快照事件数 */
  readonly skipped: number;
}

export interface ProfileSummary {
  readonly id: string;
  readonly capturedAt: number;
  readonly sessionCount: number;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly temporalPatterns: number;
  readonly summary: string;
  /** facts + preferences + principles，界面直接显示"记忆 N 条" */
  readonly totalMemories: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPrinciple(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value['content'] === 'string' &&
    isFiniteNumber(value['confidence']) &&
    isCount(value['applied']) &&
    isCount(value['succeeded'])
  );
}

function isPerDomain(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      isCount(entry['memories']) &&
      isCount(entry['principles']),
  );
}

/**
 * 结构校验：只认完整快照。
 *
 * ⚠️ 这是**运行时**校验，不是 TypeScript 类型断言 ——
 *    事件 payload 来自磁盘，可能是旧版本、被手工改过或损坏的 JSON。
 *    宽松接受会让界面读到 `undefined.toFixed`，严格拒绝只会少一条快照。
 */
export function isProfileSnapshot(value: unknown): value is ProfileSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false;
  if (typeof value['userId'] !== 'string') return false;
  if (!isFiniteNumber(value['capturedAt'])) return false;
  if (!isCount(value['sessionCount'])) return false;
  if (!isCount(value['facts'])) return false;
  if (!isCount(value['preferences'])) return false;
  if (!isCount(value['principles'])) return false;
  if (!isCount(value['temporalPatterns'])) return false;
  if (!isPerDomain(value['perDomain'])) return false;
  if (!Array.isArray(value['principleList'])) return false;
  if (!value['principleList'].every(isPrinciple)) return false;
  if (typeof value['summary'] !== 'string') return false;
  return true;
}

/** 从事件流读出全部完整快照（按 capturedAt 升序，同 id 保留最后一个）。 */
export function readProfileHistory(events: readonly SessionEvent[]): ProfileHistory {
  const byId = new Map<string, ProfileSnapshot>();
  let skipped = 0;

  for (const event of events) {
    if (event.type !== 'profile.snapshot') continue;

    const payload = event.payload;
    const raw = isRecord(payload) ? payload['snapshot'] : undefined;
    if (!isProfileSnapshot(raw)) {
      skipped += 1;
      continue;
    }
    byId.set(raw.id, raw);
  }

  const profiles = [...byId.values()].sort(
    (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id),
  );

  return { profiles, skipped };
}

/** 按 id 取一份完整快照。 */
export function findProfile(
  history: ProfileHistory,
  id: string,
): ProfileSnapshot | undefined {
  return history.profiles.find((p) => p.id === id);
}

/** 列表用的轻量摘要（不含 principleList / perDomain 明细）。 */
export function summarizeProfile(profile: ProfileSnapshot): ProfileSummary {
  return {
    id: profile.id,
    capturedAt: profile.capturedAt,
    sessionCount: profile.sessionCount,
    facts: profile.facts,
    preferences: profile.preferences,
    principles: profile.principles,
    temporalPatterns: profile.temporalPatterns,
    summary: profile.summary,
    totalMemories: profile.facts + profile.preferences + profile.principles,
  };
}
