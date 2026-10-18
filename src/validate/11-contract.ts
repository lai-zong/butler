/**
 * 验证 11：任务契约的真实质量（v7 · D-5）
 *
 * ★ 为什么必须用真模型验：契约是**模型写出来的**。
 *   假模型只能验"代码逻辑对不对"，验不了"契约写得好不好" ——
 *   而契约质量直接决定监督员能否核对出问题。
 *
 * ⚠️ 判据（先说清，避免事后找理由）：
 *   ① 交付物写的是**结果**不是过程（不能出现"我先…然后…"）
 *   ② 判据**可判定**（不能出现"尽量""努力""合理"这类无法判定的词）
 *   ③ 硬约束**有依据**（不能编造用户没说的约束）
 *   ④ 领域标签**不过度**（判不出就该少，不能五个全填）
 */

import { deepSeekConfigFromEnv, DeepSeekModel } from '../adapters/model/deepseek.js';
import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { writeContract, renderContractForReview } from '../core/butler/contract.js';
import type { ScoredMemory } from '../core/memory/recall.js';
import type { MemoryEntry } from '../core/memory/types.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}
function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

const T0 = 1_760_000_000_000;

function mem(id: string, content: string, memClass: string, relevance = 0.9): ScoredMemory {
  return {
    memory: {
      id,
      memClass,
      kind: 'fact',
      content,
      confidence: 0.9,
      evidence: [],
      owner: { kind: 'butler', userId: 'u' },
    } as unknown as MemoryEntry,
    score: 0.9,
    relevance,
    fitness: 0.8,
    confidence: 0.9,
    exploratory: false,
    why: '',
  } as ScoredMemory;
}

/** 无法判定的措辞 —— 出现**且没有具体界限**时才说明判据不可核对 */
const VAGUE = ['尽量', '努力', '合理', '适当', '尽可能', '差不多', '大概'];

/**
 * ★★ 「具体界限」的证据 —— 有它，模糊词就不是问题。
 *
 * ⚠️ 这条规则是**修假红**改出来的，起因是一次实测：
 *
 *   模型给的判据是：
 *     「每套方案标注每餐用油量，且控制在减脂期**合理范围**内
 *       （**每餐食用油不超过 5g/人**）」
 *
 *   旧断言用 `includes('合理')` 直接判红 —— 但这条判据**给了具体上限**
 *   （5g/人），是**完全可核对**的。真正的空话是「合理搭配」那种。
 *
 *   ★ 假红的代价不是"少一条绿"，而是**"验证全绿"这个信号失真** ——
 *     之后任何一次真失败都可能被当成波动忽略掉。
 *
 * ★ 判定口径（精确化）：
 *     模糊词 + **有**具体界限 → 可核对（界限把模糊词钉住了）
 *     模糊词 + **无**具体界限 → 不可核对（确实是空话）
 *
 * ⚠️ 这是启发式，不是语义理解。它只认「数字+单位」或「比较词+数字」
 *    这两种最明确的量化形式 —— 宁可漏判，也不要把"给了界限"误判成空话。
 */
const BOUNDED: readonly RegExp[] = [
  // 数字 + 单位（5g / 30分钟 / 200千卡 / 3次 / 20%）
  /\d+(?:\.\d+)?\s*(?:g|kg|ml|l|克|千克|毫升|升|分钟|小时|次|元|块|%|kcal|千卡|大卡|人)/i,
  // 比较词 + 数字（不超过5 / ≥3 / 至少2）
  /(?:不超过|不少于|不低于|不高于|至少|最多|≥|≤|<=|>=)\s*\d/,
  // 数字 + 范围后缀（3以内 / 5以下）
  /\d+(?:\.\d+)?\s*(?:以内|以下|以上|之内)/,
];

/** 判据是否可核对：模糊词必须被具体界限钉住。 */
function isJudgeable(criterion: string): boolean {
  const hasVague = VAGUE.some((v) => criterion.includes(v));
  if (!hasVague) return true;
  return BOUNDED.some((rx) => rx.test(criterion));
}

async function main(): Promise<void> {
  const cfg = deepSeekConfigFromEnv();
  const model = new DeepSeekModel(cfg);
  const clock = new FixedClock(T0);

  console.log('\n▶ 验证 11：任务契约的真实质量\n');
  console.log(`  模型：${cfg.model}`);

  // ── 场景 1：跨领域 + 硬约束 ──
  hr('场景 1：跨领域 + 硬约束（花生过敏 + 减脂）');

  const recalled = [
    mem('m1', '用户对花生严重过敏', 'global_constraint'),
    mem('m2', '用户正在减脂期，需要控制油脂摄入', 'global_shared'),
    mem('m3', '用户偏好清淡口味', 'domain'),
  ];

  const log1 = new EventLog('v11a');
  const t0 = Date.now();
  const r1 = await writeContract({
    model,
    log: log1,
    sessionId: 'v11a',
    userGoal: '今晚想吃点好的，但我花生过敏，最近也在减脂',
    recalled,
    now: clock.now(),
  });
  const ms1 = Date.now() - t0;

  console.log(`  耗时 ${ms1}ms · 用量 ${r1.usage.inputTokens}→${r1.usage.outputTokens} token\n`);
  console.log('  ── 契约 ──');
  console.log(renderContractForReview(r1.contract).replace(/^/gm, '  '));

  console.log('\n  ── 检查 ──');
  check('交付物非空', r1.contract.deliverable.length > 4, r1.contract.deliverable.slice(0, 30));
  check('判据 ≥ 1 条', r1.contract.criteria.length >= 1, `${r1.contract.criteria.length} 条`);

  const vagueHits = r1.contract.criteria.filter((c) => !isJudgeable(c));
  check(
    '★ 判据里没有无法判定的措辞',
    vagueHits.length === 0,
    vagueHits.length > 0 ? `含：${vagueHits.join(' / ')}` : '无"尽量/努力/合理"类措辞',
  );

  check(
    '★★ 硬约束抓到了花生过敏',
    r1.contract.mustObey.some((c) => c.includes('花生')),
    r1.contract.mustObey.join(' · ').slice(0, 40),
  );

  check(
    '★ 领域标签包含 health（减脂/过敏）',
    r1.contract.domains.includes('health'),
    r1.contract.domains.join(','),
  );

  check(
    '★ 领域标签没有过度标注（≤3 个）',
    r1.contract.domains.length <= 3,
    `${r1.contract.domains.length} 个：${r1.contract.domains.join(',')}`,
  );

  // ── 场景 2：单一领域，信息很少 ──
  hr('场景 2：信息很少（检验"判不出就别硬猜"）');

  const log2 = new EventLog('v11b');
  const r2 = await writeContract({
    model,
    log: log2,
    sessionId: 'v11b',
    userGoal: '帮我想想',
    recalled: [],
    now: clock.now(),
  });

  console.log('  ── 契约 ──');
  console.log(renderContractForReview(r2.contract).replace(/^/gm, '  '));

  console.log('\n  ── 检查 ──');
  check('★★ 领域不过度（信息极少时 ≤2 个）', r2.contract.domains.length <= 2, r2.contract.domains.join(','));
  check(
    '★★ 没有编造硬约束',
    r2.contract.mustObey.length === 0,
    r2.contract.mustObey.length === 0 ? '正确：无依据就不写' : `⚠️ 编造了：${r2.contract.mustObey.join(' / ')}`,
  );

  // ── 场景 3：代码任务（检验领域判断跳到 code）──
  hr('场景 3：领域判断是否正确（代码任务）');

  const log3 = new EventLog('v11c');
  const r3 = await writeContract({
    model,
    log: log3,
    sessionId: 'v11c',
    userGoal: '这个 TypeScript 文件报错了，帮我看看怎么修',
    recalled: [],
    now: clock.now(),
  });

  console.log(`  领域：${r3.contract.domains.join(',')}`);
  console.log(`  交付物：${r3.contract.deliverable}`);
  check('★ 识别为 code 领域', r3.contract.domains.includes('code'), r3.contract.domains.join(','));
  check(
    '★ 领域没有误标 work（"文件"这个词不该触发办公域）',
    !r3.contract.domains.includes('work') || r3.contract.domains.length <= 2,
    r3.contract.domains.join(','),
  );

  // ── 统计 ──
  hr('结果');
  console.log(`  通过 ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log(`  ✗ 失败 ${failed} 项`);
    console.log('\n▶ 验证 11 未通过\n');
    process.exit(1);
  }
  console.log('\n▶ 验证 11 通过：契约写得可核对、硬约束有依据、领域不过度\n');
}

await main();
