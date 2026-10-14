/**
 * 验证 4 · 行为观察与成长对比（零 token，纯确定性）
 *
 * 目的：这一块的价值在于"**能看到**"，所以验证脚本直接把它渲染出来。
 *
 * 通过条件：
 *   ① 默认不采集；同意后才开始
 *   ② 采集边界生效（应用名里的文档名被剥掉）
 *   ③ 样本不足时不产出规律；够了才产出
 *   ④ 演示数据走真实算法（只有数据是模拟的）
 *   ⑤ 成长对比能看出"记忆 12 → 47、原则 0 → 6"这种变化
 *
 * 运行：pnpm validate:4
 */

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { MemoryStore } from '../core/memory/store.js';
import { ActivityObserver, sanitizeAppName } from '../core/activity/observe.js';
import { derivePatterns, patternGuidance } from '../core/activity/patterns.js';
import { captureProfile, renderSideBySide } from '../core/activity/profile.js';
import { DEMO_OFFICE_DEV, generateDemoRecords } from '../core/activity/demo.js';
import { DEFAULT_CONSENT } from '../core/activity/observe.js';
import type { TemporalPattern } from '../core/activity/types.js';

const line = (s = ''): void => console.log(s);
const hr = (t: string): void => {
  line();
  line('─'.repeat(72));
  line(`  ${t}`);
  line('─'.repeat(72));
};

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  checks.push({ name, pass, detail });
};

const USER = 'u_validate4';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 演示用固定"现在"：2026-10-13 14:00（周二）
const NOW = new Date(2026, 9, 13, 14, 0, 0).getTime();

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 4 · 行为观察与成长对比（零 token）' + ' '.repeat(29) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const log = new EventLog('s_validate_04');
  const clock = new FixedClock(NOW);

  // ═══════════════════════════════════════════════════════
  hr('① 采集边界（防线一）');
  // ═══════════════════════════════════════════════════════

  line('  净化应用名 —— 这是防"后门采集"的关键：');
  for (const raw of [
    'Excel - 2026年财报.xlsx',
    'C:\\Program Files\\Office\\EXCEL.EXE',
    'Visual Studio Code — main.ts',
    '记事本(会议记录.txt)',
  ]) {
    line(`    "${raw}"`);
    line(`      → "${sanitizeAppName(raw)}"`);
  }
  const sanitized = sanitizeAppName('Excel - 2026年财报.xlsx');
  check('① 文档名被剥离', sanitized === 'Excel', sanitized);
  check('① 路径被剥离', !sanitizeAppName('D:\\x\\y.exe').includes('\\'));

  // ═══════════════════════════════════════════════════════
  hr('② 默认不采集（防线三）');
  // ═══════════════════════════════════════════════════════

  const closed = new ActivityObserver(log, clock, USER, DEFAULT_CONSENT);
  const denied = closed.observe({
    app: 'Excel',
    startedAt: NOW,
    endedAt: NOW + HOUR,
    hadInput: true,
  });
  line(`  未同意时采集：${denied.recorded ? '⚠️ 记录了' : '✓ 被拒绝'}`);
  line(`  原因：${denied.reason ?? '（无）'}`);
  check('② 默认不采集', denied.recorded === false);

  // 演示需要 30 天数据，所以保留期设为 30 天（方案允许 7/14/30）
  const observer = new ActivityObserver(log, clock, USER, {
    granted: true,
    grantedAt: NOW,
    enabled: true,
    retentionDays: 30,
  });
  line('  用户显式同意后开启采集（保留期设为 30 天，用于演示）。');

  // ═══════════════════════════════════════════════════════
  hr('③ 样本不足时不产出规律');
  // ═══════════════════════════════════════════════════════

  const few = new ActivityObserver(log, clock, USER, {
    granted: true, grantedAt: NOW, enabled: true, retentionDays: 30,
  });
  for (let d = 0; d < 3; d++) {
    const at = NOW - d * DAY + 10 * HOUR;
    few.observe({ app: 'Excel', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });
  }
  const fewResult = derivePatterns({
    aggregates: few.aggregate(NOW),
    options: { log, clock, userId: USER },
  });
  line(`  只采集 3 天 → 规律 ${fewResult.patterns.length} 条`);
  line(`  系统说明：${fewResult.reason ?? '（无）'}`);
  check('③ 样本不足不产出规律', fewResult.patterns.length === 0, fewResult.reason ?? '');

  // ═══════════════════════════════════════════════════════
  hr('④ 演示数据走真实算法（30 天）');
  // ═══════════════════════════════════════════════════════

  const records = generateDemoRecords({
    profile: DEMO_OFFICE_DEV,
    userId: USER,
    days: 30,
    endAt: NOW,
  });
  line(`  画像：${DEMO_OFFICE_DEV.name} —— ${DEMO_OFFICE_DEV.description}`);
  line(`  生成 ${records.length} 条活动记录（source = demo，诚实标注）`);

  let accepted = 0;
  for (const r of records) {
    const res = observer.observe({
      app: r.app,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      hadInput: r.hadInput,
      source: r.source,
    });
    if (res.recorded) accepted += 1;
  }
  line(`  经三道闸门后实际记录 ${accepted} 条`);

  const aggregates = observer.aggregate(NOW);
  line(`  聚合为 ${aggregates.length} 个小时桶（长期保留，原始记录将按保留期清除）`);

  const derived = derivePatterns({
    aggregates,
    options: { log, clock, userId: USER, demo: true },
  });

  line();
  line(`  观察 ${derived.observedDays} 天，提取出 ${derived.patterns.length} 条规律：`);
  line();
  for (const p of derived.patterns.slice(0, 10)) {
    const kind = p.kind === 'routine' ? '作息' : p.kind === 'preference' ? '偏好' : '空闲';
    line(`    [${kind}] ${p.pattern}`);
    line(`           置信度 ${(p.confidence * 100).toFixed(0)}% · 观察 ${p.observedDays} 天`);
    line(`           管家用法：${patternGuidance(p)}`);
  }
  if (derived.patterns.length > 10) {
    line(`    … 还有 ${derived.patterns.length - 10} 条`);
  }

  check('④ 产出规律', derived.patterns.length > 0, `${derived.patterns.length} 条`);
  check('④ 观察天数够', derived.observedDays >= 20, `${derived.observedDays} 天`);
  check(
    '④ 置信度不是拍脑袋的 1.0',
    derived.patterns.every((p) => p.confidence <= 0.95),
  );
  check(
    '④ 演示来源被标注',
    (log.byType('pattern.derived')[0]?.payload as { fromDemoData?: boolean } | undefined)
      ?.fromDemoData === true,
  );

  // ═══════════════════════════════════════════════════════
  hr('⑤ 分层存储：长期留规律，不留原始记录');
  // ═══════════════════════════════════════════════════════

  const beforeRaw = observer.rawRecords(NOW).length;
  const later = NOW + 60 * DAY; // 远超 30 天保留期
  const purged = observer.purgeExpired(later);
  line(`  60 天后清除原始记录：${purged.purged} 条（原有 ${beforeRaw} 条）`);
  line(`  剩余原始记录：${observer.rawRecords(later).length} 条`);
  line(`  聚合结果仍在：${observer.allAggregates().length} 条 ✓`);
  check('⑤ 原始记录被清除', observer.rawRecords(later).length === 0);
  check('⑤ 聚合结果长期保留', observer.allAggregates().length > 0);

  // ═══════════════════════════════════════════════════════
  hr('⑥ ★ 成长对比（方案 § 3.3 自认的「最强演示件」）');
  // ═══════════════════════════════════════════════════════

  const butler = { kind: 'butler', userId: USER } as const;

  // session 10 的状态：少量事实、没有原则
  const earlyStore = new MemoryStore(log, new FixedClock(NOW), USER);
  const earlyFacts = [
    '你对花生严重过敏', '你偏好简短回复', '你常点外卖',
    '你住在杭州', '你在做后端开发', '你用 Windows',
    '你有一个朋友叫小李', '你周末喜欢在家', '你喝咖啡不加糖',
    '你工作日在公司', '你晚上 11 点后不回复', '你不用微信支付',
  ];
  for (const [i, c] of earlyFacts.entries()) {
    earlyStore.create(butler, {
      id: `e${i}`,
      memClass: 'global_shared',
      kind: 'fact',
      content: c,
      confidence: 0.75,
      evidence: [`session_${i}`],
      lifecycle: 'active',
    });
  }

  // session 50 的状态：事实 + 偏好 + 原则
  const lateStore = new MemoryStore(log, new FixedClock(NOW), USER);
  const lateItems: { c: string; k: 'fact' | 'preference' | 'principle'; applied?: number; ok?: number }[] = [
    ...earlyFacts.map((c) => ({ c, k: 'fact' as const })),
    { c: '你先要结论后要细节', k: 'preference' },
    { c: '你偏好命令行而不是图形界面', k: 'preference' },
    { c: '批量操作前你要先看预览', k: 'preference' },
    { c: '你删除文件前希望被确认', k: 'preference' },
    { c: '小李是朋友且素食', k: 'fact' },
    { c: '工作日 9—18 点通常较忙', k: 'fact' },
    { c: '周末晚间偏好影音娱乐', k: 'fact' },
    { c: '推荐餐厅前先确认同行人忌口', k: 'principle', applied: 7, ok: 7 },
    { c: '提交代码前先跑测试', k: 'principle', applied: 12, ok: 11 },
    { c: '涉及金额的操作先给预览再执行', k: 'principle', applied: 4, ok: 4 },
    { c: '日程安排要预留缓冲时间', k: 'principle', applied: 6, ok: 5 },
  ];
  for (const [i, it] of lateItems.entries()) {
    lateStore.create(butler, {
      id: `l${i}`,
      memClass: 'global_shared',
      kind: it.k,
      content: it.c,
      confidence: 0.85,
      evidence: [`session_${i}`],
      lifecycle: 'active',
    });
    if (it.applied !== undefined) {
      lateStore.setEffectiveness(`l${i}`, {
        applied: it.applied,
        succeeded: it.ok ?? it.applied,
        lastAppliedAt: NOW,
      });
    }
  }

  const earlySnap = captureProfile({
    log, clock, store: earlyStore, userId: USER, patterns: [], sessionCount: 10,
  });
  const lateSnap = captureProfile({
    log, clock, store: lateStore, userId: USER, patterns: derived.patterns, sessionCount: 50,
  });

  line();
  for (const l of renderSideBySide(earlySnap, lateSnap).split('\n')) line(`  ${l}`);

  check('⑥ 快照生成', earlySnap.sessionCount === 10 && lateSnap.sessionCount === 50);
  check('⑥ 原则数体现成长', earlySnap.principles === 0 && lateSnap.principles === 4);
  check('⑥ 生活节奏进入画像', lateSnap.temporalPatterns > 0);

  // ═══════════════════════════════════════════════════════
  hr('结果汇总');
  // ═══════════════════════════════════════════════════════

  const passed = checks.filter((c) => c.pass).length;
  for (const c of checks) {
    line(`  ${c.pass ? '✓' : '✗'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  line();
  line(`  通过 ${passed}/${checks.length}`);
  line();
  line('  ★ 本验证零 token —— 全是确定性代码。');
  line('    演示数据的来源被标注为 demo，但聚合、规律提取、置信度计算');
  line('    走的都是与真实采集完全相同的那一套代码。');
  line();

  const allPass = passed === checks.length;
  line(allPass ? '  ▶ 验证 4 通过：行为观察与成长对比成立' : '  ▶ 验证 4 未通过：见上方 ✗ 项');
  line();
  process.exit(allPass ? 0 : 1);
}

main().catch((err: unknown) => {
  line(`致命错误：${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) line(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});

/** 类型自检。 */
const _t: TemporalPattern | undefined = undefined;
void _t;
