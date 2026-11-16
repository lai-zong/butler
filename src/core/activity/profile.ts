/**
 * 成长画像 —— 方案 § 3.3 自认的「最强演示件」
 *
 * 设计依据：方案 § 3.3、§ 8.6
 *
 * ★ 它为什么是最强演示件：
 *   "记忆会演化"这句话本身无法演示 —— 观众看不到演化。
 *   但**两个快照并排**就能看到：
 *
 *          session 10                  session 50
 *      ──────────────────        ──────────────────
 *      记忆 12 条                 记忆 47 条
 *      原则  0 条                 原则  6 条
 *      生活节奏 —                 生活节奏 3 条
 *
 *   它把"渐进式演化"这个抽象主张变成了**可对比的数字与清单**。
 *
 * ⚠️ 一个诚实的纪律：
 *   快照是**只读派生**，不是新的事实来源。它不写记忆库、不参与演化。
 *   同一批输入必须产出同一份快照 —— 否则"成长对比"就成了编故事。
 */

import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import { principleStats } from '../memory/principles.js';
import { DOMAIN_IDS, domainName, type DomainId } from '../domain/types.js';
import type { TemporalPattern } from '../activity/types.js';

// ═══════════════════════════════════════════════════════════
// 类型（方案 § 3.3）
// ═══════════════════════════════════════════════════════════

export interface ProfileSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly capturedAt: number;
  readonly sessionCount: number;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly perDomain: Readonly<Record<string, { readonly memories: number; readonly principles: number }>>;
  readonly temporalPatterns: number;
  readonly principleList: readonly {
    readonly content: string;
    readonly confidence: number;
    readonly applied: number;
    readonly succeeded: number;
  }[];
  readonly summary: string;
}

// ═══════════════════════════════════════════════════════════
// 采集
// ═══════════════════════════════════════════════════════════

export function captureProfile(args: {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly userId: string;
  readonly patterns: readonly TemporalPattern[];
  /** 已完成的会话数 */
  readonly sessionCount: number;
}): ProfileSnapshot {
  const all = args.store.all();

  // ★ 只统计**已生效**的记忆 —— 候选还没被用户承认，算进"我了解你"是虚报
  const active = all.filter((m) => m.lifecycle === 'active');

  const facts = active.filter((m) => m.kind === 'fact').length;
  const preferences = active.filter((m) => m.kind === 'preference').length;
  const principles = active.filter((m) => m.kind === 'principle').length;

  // 分领域统计
  const perDomain: Record<string, { memories: number; principles: number }> = {};
  for (const s of DOMAIN_IDS) {
    perDomain[s] = { memories: 0, principles: 0 };
  }
  for (const m of active) {
    if (m.memClass !== 'domain' || m.domain === undefined) continue;
    const key = m.domain;
    const cur = perDomain[key];
    if (!cur) continue;
    cur.memories += 1;
    if (m.kind === 'principle') cur.principles += 1;
  }

  // 原则清单（界面直接展示"我了解你什么"）
  const principleList = active
    .filter((m) => m.kind === 'principle')
    .map((m) => ({
      content: m.content,
      confidence: m.confidence,
      applied: m.effectiveness?.applied ?? 0,
      succeeded: m.effectiveness?.succeeded ?? 0,
    }))
    // 效果好的排前面；无记录按置信度
    .sort((a, b) => {
      const ra = a.applied > 0 ? a.succeeded / a.applied : 0.5;
      const rb = b.applied > 0 ? b.succeeded / b.applied : 0.5;
      if (rb !== ra) return rb - ra;
      return b.confidence - a.confidence;
    });

  const id = `snap_${args.clock.now().toString(36)}_${args.sessionCount}`;

  const snapshot: ProfileSnapshot = {
    id,
    userId: args.userId,
    capturedAt: args.clock.now(),
    sessionCount: args.sessionCount,
    facts,
    preferences,
    principles,
    perDomain,
    temporalPatterns: args.patterns.length,
    principleList,
    summary: buildSummary({
      sessionCount: args.sessionCount,
      facts,
      preferences,
      principles,
      patternCount: args.patterns.length,
      perDomain,
    }),
  };

  args.log.append({
    type: 'profile.snapshot',
    actor: 'butler',
    payload: {
      snapshotId: id,
      sessionCount: snapshot.sessionCount,
      facts,
      preferences,
      principles,
      temporalPatterns: snapshot.temporalPatterns,
      activeMemories: active.length,
      /**
       * ★★ 完整快照必须落事件，否则重启后无法做"成长对比"。
       *
       * ⚠️ 原实现只写计数：`profile.snapshot` 事件里没有 perDomain /
       *    principleList / summary，`tasks.ts` 的 previous/latest 又只是
       *    模块变量 —— 进程一重启，两份快照都没了，diff 只能在同一进程
       *    的两次周任务之间发生。
       *
       *    现在把 snapshot 原样放进 payload：事件是唯一真相源，
       *    重放/回看/导出都能拿到完整画像；旧事件没有这个字段，
       *    读取端会按"不完整快照"跳过（见 activity/profileHistory.ts）。
       */
      snapshot,
      // 只读派生 —— 明确不写记忆库
      readOnlyDerivation: true,
    },
    createdAt: args.clock.now(),
  });

  return snapshot;
}

// ═══════════════════════════════════════════════════════════
// 对比
// ═══════════════════════════════════════════════════════════

export interface ProfileDelta {
  readonly from: ProfileSnapshot;
  readonly to: ProfileSnapshot;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly temporalPatterns: number;
  readonly totalMemories: number;
  /** 新增的原则（旧快照里没有的） */
  readonly newPrinciples: readonly string[];
  /** 这些原则中已经被应用过的（说明"学了真的在用"） */
  readonly appliedPrinciples: readonly string[];
  /** 一句话总结成长 */
  readonly headline: string;
}

/**
 * 对比两份快照。
 *
 * ⚠️ 比较原则用**内容**而非 id —— 快照之间 id 必然不同，
 *    按 id 比会得出"全部换了一遍"的荒谬结论。
 */
export function diffProfiles(from: ProfileSnapshot, to: ProfileSnapshot): ProfileDelta {
  const fromSet = new Set(from.principleList.map((p) => p.content));
  const newPrinciples = to.principleList
    .filter((p) => !fromSet.has(p.content))
    .map((p) => p.content);
  const appliedPrinciples = to.principleList
    .filter((p) => !fromSet.has(p.content) && p.applied > 0)
    .map((p) => p.content);

  const totalFrom = from.facts + from.preferences + from.principles;
  const totalTo = to.facts + to.preferences + to.principles;

  const growth = totalTo - totalFrom;
  const headline =
    growth === 0
      ? `会话数从 ${from.sessionCount} 到 ${to.sessionCount}，但记忆数没有增长`
      : `经过 ${to.sessionCount - from.sessionCount} 次会话，` +
        `我多了解你 ${growth} 条（记忆 ${totalFrom} → ${totalTo}）` +
        (newPrinciples.length > 0 ? `，新增 ${newPrinciples.length} 条原则` : '');

  return {
    from,
    to,
    facts: to.facts - from.facts,
    preferences: to.preferences - from.preferences,
    principles: to.principles - from.principles,
    temporalPatterns: to.temporalPatterns - from.temporalPatterns,
    totalMemories: growth,
    newPrinciples,
    appliedPrinciples,
    headline,
  };
}

/**
 * 渲染成并排文本（方案 § 3.3 的展示形式）。
 *
 * ⚠️ 这是给**终端与说明材料**用的；界面会用它自己的渲染。
 *    放在核心层是因为"并排对比"这件事本身就是演示主张的一部分，
 *    不属于某个具体界面。
 */
export function renderSideBySide(from: ProfileSnapshot, to: ProfileSnapshot): string {
  const rows: readonly (readonly [string, string, string])[] = [
    ['记忆', `${from.facts + from.preferences + from.principles} 条`, `${to.facts + to.preferences + to.principles} 条`],
    ['  事实', `${from.facts} 条`, `${to.facts} 条`],
    ['  偏好', `${from.preferences} 条`, `${to.preferences} 条`],
    ['原则', `${from.principles} 条`, `${to.principles} 条`],
    ['生活节奏', from.temporalPatterns === 0 ? '—' : `${from.temporalPatterns} 条`, to.temporalPatterns === 0 ? '—' : `${to.temporalPatterns} 条`],
  ];

  const w = (s: string): number => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - w(s)));

  // ⚠️ 列宽要按"分隔行的总宽"反推，否则表头与分隔线对不齐
  //    （第一版把两段宽度各取 max 后相加，比表头实际宽度多，视觉上偏了）。
  const L = Math.max(...rows.map((r) => w(r[0] ?? ''))) + 2;
  const A = Math.max(...rows.map((r) => w(r[1] ?? ''))) + 4;
  const B = Math.max(...rows.map((r) => w(r[2] ?? ''))) + 2;
  const totalWidth = L + A + B;

  const lines: string[] = [];
  const headLeft = `会话 ${from.sessionCount}`;
  const headRight = `会话 ${to.sessionCount}`;
  lines.push(pad(headLeft, totalWidth - w(headRight)) + headRight);
  lines.push('─'.repeat(totalWidth));
  for (const [label, a, b] of rows) {
    lines.push(`${pad(label ?? '', L)}${pad(a ?? '', A)}${b ?? ''}`);
  }

  lines.push('');
  lines.push('我了解你：');
  const shown = to.principleList.slice(0, 8);
  if (shown.length === 0) {
    lines.push('  （还没有提炼出可复用的规律）');
  } else {
    for (const p of shown) {
      const eff = p.applied > 0 ? `  [应用 ${p.applied} 次，奏效 ${p.succeeded} 次]` : '';
      lines.push(`  · ${p.content}${eff}`);
    }
    if (to.principleList.length > shown.length) {
      lines.push(`  … 还有 ${to.principleList.length - shown.length} 条`);
    }
  }

  const d = diffProfiles(from, to);
  lines.push('');
  lines.push(`▶ ${d.headline}`);
  if (d.appliedPrinciples.length > 0) {
    lines.push(
      `  其中 ${d.appliedPrinciples.length} 条已经在实际任务中被用到 —— 学过的东西真的在用。`,
    );
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

function buildSummary(args: {
  readonly sessionCount: number;
  readonly facts: number;
  readonly preferences: number;
  readonly principles: number;
  readonly patternCount: number;
  readonly perDomain: Readonly<Record<string, { readonly memories: number; readonly principles: number }>>;
}): string {
  const total = args.facts + args.preferences + args.principles;
  if (total === 0) {
    return `第 ${args.sessionCount} 次会话，还没有形成可复用的记忆。`;
  }

  // 找出记忆最多的领域（说明「我最了解你的哪一方面」）
  const top = (Object.entries(args.perDomain) as [DomainId, { memories: number }][])
    .filter(([, v]) => v.memories > 0)
    .sort((a, b) => b[1].memories - a[1].memories)[0];

  const parts = [
    `第 ${args.sessionCount} 次会话，共记住 ${total} 条`,
    `${args.facts} 条事实`,
    `${args.preferences} 条偏好`,
    `${args.principles} 条原则`,
  ];
  if (args.patternCount > 0) parts.push(`${args.patternCount} 条生活节奏`);
  /**
   * ★★ v8（P3）：用户可见文案里不再出现「仆人」。
   *
   * ⚠️ 原来写 `最了解你的${SERVANT_BOUNDARY[top[0]].name}`
   *    → 界面会显示「最了解你的**生活仆人**」——
   *      单执行者架构下**没有仆人**，这是**界面在对用户说假话**。
   *
   * ✅ 改为「其中「生活」方面记得最多」：
   *    领域是内部工作分类，这样表述既准确，用户也看得懂"它记住了我哪些方面"。
   */
  if (top) parts.push(`其中「${domainName(top[0])}」方面记得最多（${top[1].memories} 条）`);

  return `${parts.join('、')}。`;
}

/** 从 store 直接取一份原则统计（供调用方使用）。 */
export function snapshotStats(store: MemoryStore): ReturnType<typeof principleStats> {
  return principleStats(store);
}
