/**
 * 行为观察 —— 采集、同意、保留期、聚合
 *
 * 设计依据：方案 § 7.3 三道防线
 *
 * ★ 本模块最重要的不是"能采集什么"，而是**"拒绝采集什么"**：
 *   · 类型层面：`ActivityRecord` 里没有任何放标题/URL/路径的位置（详见 types.ts）
 *   · 采样而非持续记录：每 5 分钟采样一次，**不是键盘记录器**
 *   · 分层存储：原始记录 7 天后自动清除，长期只留聚合
 *   · 用户控制：显式同意才开启、一键关闭、可查看可删除
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import {
  bucketOf,
  categorize,
  type ActivityAggregate,
  type ActivityCategory,
  type ActivityRecord,
} from './types.js';

// ═══════════════════════════════════════════════════════════
// 防线三 · 用户控制
// ═══════════════════════════════════════════════════════════

/** 原始记录保留期限（毫秒）。方案：7 / 14 / 30 天 / 不保留。 */
export const RETENTION_OPTIONS = [7, 14, 30, 0] as const;

export interface ObservationConsent {
  /** 是否已显式同意（**默认 false** —— 绝不默认开启） */
  readonly granted: boolean;
  readonly grantedAt?: number;
  /** 采集开关（同意之后仍可一键关闭） */
  readonly enabled: boolean;
  /** 原始记录保留天数；0 表示不保留原始记录（只留聚合） */
  readonly retentionDays: number;
}

export const DEFAULT_CONSENT: ObservationConsent = {
  granted: false,
  enabled: false,
  retentionDays: 7,
};

// ═══════════════════════════════════════════════════════════
// 采集端口
// ═══════════════════════════════════════════════════════════

/**
 * 前台窗口信息源。
 *
 * ⚠️ **端口只返回应用名与活跃状态** —— 不提供获取窗口标题的方法。
 *    这是结构性保证：实现者即使想采集标题，也没有接口可依。
 */
export interface ForegroundSample {
  /** 应用名（不含文档名） */
  readonly app: string;
  /** 采样瞬间是否有用户输入 */
  readonly hadInput: boolean;
}

export interface ActivitySourcePort {
  /**
   * 采样一次前台窗口。
   *
   * ⚠️ 采样**不是**持续监听 —— 调用方每 5 分钟调一次，
   *    而不是订阅键盘/窗口事件。这是"不是键盘记录器"的实现层保证。
   */
  sample(): Promise<ForegroundSample | null>;
}

/** 采样间隔（方案 § 7.3 防线一：每 5 分钟采样一次）。 */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// 观察器
// ═══════════════════════════════════════════════════════════

export interface ObserveResult {
  /** 是否真的记录了（未同意 / 未开启时返回 false） */
  readonly recorded: boolean;
  readonly reason?: string;
  readonly record?: ActivityRecord;
}

export class ActivityObserver {
  private records: ActivityRecord[] = [];
  private aggregates = new Map<string, ActivityAggregate>();
  private consent: ObservationConsent;
  private seq = 0;
  private lastSampleAt = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
    private readonly userId: string,
    consent: ObservationConsent = DEFAULT_CONSENT,
  ) {
    this.consent = consent;
  }

  // ── 防线三：用户控制 ──

  /**
   * 从事件流恢复原始记录与聚合。
   *
   * ⚠️ 旧事件没有 `recordId` / `startedAt` / `endedAt` / 聚合明细：
   *    - 记录按事件时间与时长近似重建（只用于展示，不再参与原始采集）；
   *    - 旧 `activity.aggregated` 只有计数，无法凭空恢复明细，因此跳过。
   *      新事件会带完整 `aggregates`，重启后可恢复。
   */
  replayFromLog(now?: number): void {
    this.records = [];
    this.aggregates.clear();
    this.seq = 0;

    const categories = new Set<ActivityCategory>([
      'work',
      'study',
      'entertainment',
      'communication',
      'other',
    ]);

    for (const e of this.log.all()) {
      if (e.type === 'activity.sampled') {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const action = typeof p['action'] === 'string' ? p['action'] : '';

        if (action === 'consentRevoked' || action === 'deleteAll') {
          this.records = [];
          this.aggregates.clear();
          continue;
        }
        if (action === 'deleteRecord') {
          const id = typeof p['recordId'] === 'string' ? p['recordId'] : '';
          if (id.length > 0) this.records = this.records.filter((r) => r.id !== id);
          continue;
        }

        if (typeof p['app'] !== 'string' || typeof p['durationMs'] !== 'number') continue;
        const app = sanitizeAppName(p['app']);
        const durationMs = Math.max(0, p['durationMs']);
        const startedAt = typeof p['startedAt'] === 'number' ? p['startedAt'] : e.createdAt;
        const endedAt = typeof p['endedAt'] === 'number' ? p['endedAt'] : startedAt + durationMs;
        const rawCategory = p['category'];
        const category =
          typeof rawCategory === 'string' && categories.has(rawCategory as ActivityCategory)
            ? (rawCategory as ActivityCategory)
            : categorize(app);
        const rawSource = p['source'];
        const source =
          rawSource === 'sample' || rawSource === 'session' || rawSource === 'demo'
            ? rawSource
            : 'session';
        const id = typeof p['recordId'] === 'string' ? p['recordId'] : `act_replay_${e.seq}`;

        this.records.push({
          id,
          userId: this.userId,
          app,
          category,
          startedAt,
          endedAt,
          durationMs,
          hadInput: p['hadInput'] === true,
          source,
        });
        this.seq += 1;
        continue;
      }

      if (e.type === 'activity.aggregated') {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const raw = p['aggregates'];
        if (!Array.isArray(raw)) continue;
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) continue;
          const a = item as Record<string, unknown>;
          if (
            typeof a['id'] !== 'string' ||
            typeof a['bucket'] !== 'string' ||
            typeof a['category'] !== 'string' ||
            typeof a['minutes'] !== 'number' ||
            !Array.isArray(a['topApps'])
          ) {
            continue;
          }
          const category = a['category'] as ActivityCategory;
          if (!categories.has(category)) continue;
          this.aggregates.set(a['id'], {
            id: a['id'],
            userId: typeof a['userId'] === 'string' ? a['userId'] : this.userId,
            bucket: a['bucket'],
            category,
            minutes: Math.max(0, a['minutes']),
            topApps: a['topApps'].filter((x): x is string => typeof x === 'string').slice(0, 5),
          });
        }
      }
    }

    this.purgeExpired(now);
  }

  getConsent(): ObservationConsent {
    return this.consent;
  }

  /**
   * 用户显式同意。
   *
   * ⚠️ 只有在用户真的点了"我同意"时才该调用 ——
   *    默认值是 `granted: false`，任何"帮你打开"都是违规。
   */
  grantConsent(at?: number): void {
    const now = at ?? this.clock.now();
    this.consent = { granted: true, grantedAt: now, enabled: true, retentionDays: this.consent.retentionDays };
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'consentGranted', retentionDays: this.consent.retentionDays, note: '用户显式同意' },
      createdAt: now,
    });
  }

  /** 撤回同意 —— 同时清除已采集数据（可撤回是法规要求）。 */
  revokeConsent(at?: number): { readonly deleted: number } {
    const now = at ?? this.clock.now();
    const deleted = this.records.length;
    this.records = [];
    this.aggregates.clear();
    this.consent = { ...DEFAULT_CONSENT, retentionDays: this.consent.retentionDays };
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'consentRevoked', deletedRecords: deleted, note: '撤回同意并清除已采集数据' },
      createdAt: now,
    });
    return { deleted };
  }

  /** 一键关闭采集（保留已有数据）。 */
  disable(at?: number): void {
    this.consent = { ...this.consent, enabled: false };
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'disabled' },
      createdAt: at ?? this.clock.now(),
    });
  }

  /** 重新开启采集（需此前已同意）。 */
  enable(at?: number): boolean {
    if (!this.consent.granted) return false;
    this.consent = { ...this.consent, enabled: true };
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'enabled' },
      createdAt: at ?? this.clock.now(),
    });
    return true;
  }

  /** 调整保留期限。 */
  setRetentionDays(days: number, at?: number): void {
    this.consent = { ...this.consent, retentionDays: days };
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'retentionChanged', retentionDays: days },
      createdAt: at ?? this.clock.now(),
    });
  }

  // ── 采集 ──

  /**
   * 记录一次前台会话。
   *
   * ⚠️ 三道闸门按顺序检查，任一不过就不记录：
   *    ① 是否同意  ② 是否开启  ③ 采样间隔是否到了
   */
  observe(args: {
    readonly app: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly hadInput: boolean;
    readonly source?: ActivityRecord['source'];
  }): ObserveResult {
    if (!this.consent.granted) {
      return { recorded: false, reason: '用户未同意采集（默认关闭）' };
    }
    if (!this.consent.enabled) {
      return { recorded: false, reason: '采集已被用户关闭' };
    }

    const durationMs = Math.max(0, args.endedAt - args.startedAt);
    const record: ActivityRecord = {
      id: `act_${++this.seq}_${args.startedAt.toString(36)}`,
      userId: this.userId,
      // ★ 只存应用名 —— 调用方即使传了别的东西也没有字段可放
      app: sanitizeAppName(args.app),
      category: categorize(args.app),
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      durationMs,
      hadInput: args.hadInput,
      source: args.source ?? 'session',
    };

    this.records.push(record);

    this.log.append({
      type: 'activity.sampled',
      actor: 'system',
      payload: {
        // ⚠️ 事件里也只写应用名与时长，不写任何可推断内容的信息
        recordId: record.id,
        app: record.app,
        category: record.category,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
        hadInput: record.hadInput,
        source: record.source,
        // 明确标注采了什么、没采什么 —— 审计时一眼可见立场
        boundaries: {
          appName: true,
          windowTitle: false,
          url: false,
          filePath: false,
          keystrokes: false,
        },
      },
      createdAt: this.clock.now(),
    });

    return { recorded: true, record };
  }

  /** 是否到了下一次采样时间（调用方据此决定要不要调 source.sample()）。 */
  shouldSampleNow(now?: number): boolean {
    const t = now ?? this.clock.now();
    return t - this.lastSampleAt >= SAMPLE_INTERVAL_MS;
  }

  /** 用端口采样一次并记录（供定时任务调用）。 */
  async sampleOnce(source: ActivitySourcePort, now?: number): Promise<ObserveResult> {
    const t = now ?? this.clock.now();
    if (!this.shouldSampleNow(t)) {
      return { recorded: false, reason: '未到采样间隔（避免变成持续监听）' };
    }

    /**
     * ★★ 同意/开关的检查**必须在读窗口之前**。
     *
     * ⚠️ 这是一个真实缺陷（复查时发现）：
     *    原来的顺序是"先 `source.sample()` 读前台窗口 → 再在 `observe()` 里查同意"，
     *    于是**未同意时仍然每 5 分钟读一次窗口**，只是把结果丢掉。
     *
     *    "不采集"应当等于**连读都不读** —— 读到了就有日志/崩溃转储泄漏的可能，
     *    而用户看到的却是"没开采集"。
     */
    if (!this.consent.granted) {
      return { recorded: false, reason: '用户未同意采集（默认关闭）' };
    }
    if (!this.consent.enabled) {
      return { recorded: false, reason: '采集已被用户关闭' };
    }

    this.lastSampleAt = t;

    const sample = await source.sample();
    if (!sample) return { recorded: false, reason: '采样为空（无前台窗口）' };

    // 采样只记"这一瞬间"，时长按采样间隔计
    return this.observe({
      app: sample.app,
      startedAt: t,
      endedAt: t + SAMPLE_INTERVAL_MS,
      hadInput: sample.hadInput,
      source: 'sample',
    });
  }

  // ── 防线二：分层存储 ──

  /** 原始记录（未过保留期）。 */
  rawRecords(now?: number): readonly ActivityRecord[] {
    this.purgeExpired(now);
    return this.records;
  }

  /**
   * 清除过期原始记录。
   *
   * ★ 这是"数据最小化"与"遗忘权"的落点：
   *   长期留下的是**规律与聚合**，不是原始记录。
   */
  purgeExpired(now?: number): { readonly purged: number } {
    const t = now ?? this.clock.now();
    if (this.consent.retentionDays === 0) {
      const n = this.records.length;
      this.records = [];
      // ★ 磁盘同样要清：否则重启后 replayFromLog 会把原始记录装回来
      this.log.purgeActivityBefore(Number.POSITIVE_INFINITY);
      return { purged: n };
    }
    const cutoff = t - this.consent.retentionDays * 24 * 60 * 60 * 1000;
    const before = this.records.length;
    this.records = this.records.filter((r) => r.endedAt >= cutoff);
    /**
     * ★ 关键一步：内存清完，还要把**事件流里的原文**抹掉。
     *
     *   旧实现只清内存：重启后 `replayFromLog()` 从 `activity.sampled`
     *   把应用名/时间/是否有输入重新装回来，于是"保留 7 天"只活到下次启动。
     */
    this.log.purgeActivityBefore(cutoff);
    return { purged: before - this.records.length };
  }

  /**
   * 把原始记录聚合为 `ActivityAggregate`（每小时一个类别一条）。
   *
   * 方案 § 8.6 的定时任务："行为聚合，每小时一次"。
   * 聚合结果**长期保留** —— 原始记录清除后画像仍能成立。
   */
  aggregate(now?: number): readonly ActivityAggregate[] {
    const t = now ?? this.clock.now();
    this.purgeExpired(t);

    const byKey = new Map<string, { minutes: number; apps: Map<string, number>; category: ActivityCategory }>();

    for (const r of this.records) {
      const bucket = bucketOf(r.startedAt);
      const key = `${bucket}|${r.category}`;
      const cur = byKey.get(key) ?? { minutes: 0, apps: new Map<string, number>(), category: r.category };
      cur.minutes += r.durationMs / 60000;
      cur.apps.set(r.app, (cur.apps.get(r.app) ?? 0) + r.durationMs);
      byKey.set(key, cur);
    }

    const out: ActivityAggregate[] = [];
    for (const [key, v] of byKey) {
      const [bucket] = key.split('|');
      if (bucket === undefined) continue;

      const topApps = [...v.apps.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([app]) => app);

      const agg: ActivityAggregate = {
        id: `agg_${key}`,
        userId: this.userId,
        bucket,
        category: v.category,
        minutes: Math.round(v.minutes * 10) / 10,
        topApps,
      };
      this.aggregates.set(agg.id, agg);
      out.push(agg);
    }

    this.log.append({
      type: 'activity.aggregated',
      actor: 'system',
      payload: {
        buckets: out.length,
        categories: [...new Set(out.map((a) => a.category))],
        totalMinutes: Math.round(out.reduce((s, a) => s + a.minutes, 0)),
        // ★ 持久化完整聚合，重启后才能恢复明细；旧事件只有计数。
        aggregates: out,
        note: '原始记录将在保留期后清除，聚合结果长期保留',
      },
      createdAt: t,
    });

    return out;
  }

  /** 已有的聚合结果（长期保留，不受保留期影响）。 */
  allAggregates(): readonly ActivityAggregate[] {
    return [...this.aggregates.values()];
  }

  // ── 用户查看与删除 ──

  /** 清空全部（原始 + 聚合 + 规律由上层处理）。 */
  deleteAll(at?: number): { readonly records: number; readonly aggregates: number } {
    const r = this.records.length;
    const a = this.aggregates.size;
    this.records = [];
    this.aggregates.clear();
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'deleteAll', deletedRecords: r, deletedAggregates: a },
      createdAt: at ?? this.clock.now(),
    });
    return { records: r, aggregates: a };
  }

  /** 删除单条原始记录。 */
  deleteRecord(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.log.append({
      type: 'activity.sampled',
      actor: 'user',
      payload: { action: 'deleteRecord', recordId: id, note: '用户删除单条原始记录' },
      createdAt: this.clock.now(),
    });
    return true;
  }
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

/**
 * 净化应用名：去掉可能夹带内容的括号与路径。
 *
 * ⚠️ 这是防"后门采集"：如果调用方传了
 *    `"Excel - 2026年财报.xlsx"`，直接存下就等于采了文档名。
 *    所以在这里剥掉"应用名 - 文档名"这类结构。
 */
export function sanitizeAppName(raw: string): string {
  let s = raw.trim();
  // 去掉路径部分
  const slash = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (slash >= 0) s = s.slice(slash + 1);
  // 去掉 ".exe" 后缀
  s = s.replace(/\.exe$/i, '');
  // ★ 去掉"应用名 - 文档名"结构（破折号后是内容，属于边界之外）
  s = s.split(/\s+[-—–]\s+/)[0] ?? s;
  // 去掉括号里的补充说明（常含文档名）
  s = s.replace(/[（(][^）)]*[）)]/g, '').trim();
  return s.slice(0, 60);
}
