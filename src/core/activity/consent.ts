/**
 * 行为观察的同意重放
 *
 * ★ 为什么要重放：同意/撤回都会落事件（`activity.sampled` 里的 `action`），
 *   但 `ActivityObserver` 构造时接受的是**一个 consent 对象**。
 *   不重放的话，用户昨天点过"同意"，今天重启就变回"未同意"——
 *   而界面上显示的状态会和事件流里的记录矛盾。
 *
 * ⚠️ 只认 `action` 字段，按**事件顺序**取最后一次 —— 事件是真相源。
 */

import type { ObservationConsent } from './observe.js';
import { DEFAULT_CONSENT } from './observe.js';
import type { EventLog } from '../events/log.js';

/**
 * 同意状态相关的动作名。
 *
 * ⚠️ 刻意在**这里**列一份，而不是从 `observe.ts` 导出：
 *    `observe.ts` 里这些是各方法内联写的字面量，导出它们要改签名；
 *    而这里需要的是"重放时认哪些"，属于读侧的关注点。
 *    两边必须保持同步 —— 新增动作时**两处都要改**（测试会盯住）。
 */
type ConsentAction = 'consentGranted' | 'consentRevoked' | 'disabled' | 'enabled';

const ACTIONS = new Set<string>(['consentGranted', 'consentRevoked', 'disabled', 'enabled']);

/** 从事件流重建同意状态。没有任何记录时返回默认值（未同意）。 */
export function replayConsent(log: EventLog): ObservationConsent {
  let consent: ObservationConsent = DEFAULT_CONSENT;

  for (const e of log.all()) {
    if (e.type !== 'activity.sampled') continue;
    const p = e.payload as { action?: unknown; retentionDays?: unknown };
    const action = typeof p.action === 'string' ? p.action : '';
    if (!ACTIONS.has(action)) continue;

    const a = action as ConsentAction;
    if (a === 'consentGranted') {
      const days = typeof p.retentionDays === 'number' ? p.retentionDays : consent.retentionDays;
      consent = { granted: true, grantedAt: e.createdAt, enabled: true, retentionDays: days };
    } else if (a === 'consentRevoked') {
      consent = { ...DEFAULT_CONSENT, retentionDays: consent.retentionDays };
    } else if (a === 'disabled') {
      consent = { ...consent, enabled: false };
    } else {
      // enabled：只有已同意过才谈得上"重新开启"
      consent = consent.granted ? { ...consent, enabled: true } : consent;
    }
  }

  return consent;
}
