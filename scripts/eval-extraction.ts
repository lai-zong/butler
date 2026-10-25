/**
 * 事实抽取评测（50 条：40 条应提取 + 10 条不应提取）
 *
 * 这不是“关键词命中率”：它测的是
 *   · 关键事实有没有被抽到（key recall / full hit）；
 *   · 没有事实的发言会不会被硬凑出事实（no-fact false extraction）；
 *   · 抽出的内容是否都带可核对 quote（由 extractFacts 自身保证）。
 *
 * 运行：
 *   node --env-file-if-exists=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-extraction.ts
 */

import { DeepSeekModel, deepSeekConfigFromEnv } from '../src/adapters/model/deepseek.js';
import { EventLog } from '../src/core/events/log.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { FixedClock } from '../src/core/ports/clock.js';
import { extractFacts, quoteAppearsIn } from '../src/core/reflection/extractFacts.js';
import { EXTRACTION_CASES } from './eval-extraction-data.js';

const model = new DeepSeekModel(deepSeekConfigFromEnv());
const log = new EventLog('eval-extraction');
const clock = new FixedClock(1_760_000_000_000);
const store = new MemoryStore(log, clock, 'u-eval');

interface Row {
  readonly id: string;
  readonly category: string;
  readonly expected: readonly string[];
  readonly facts: readonly string[];
  readonly matched: readonly string[];
  readonly extra: readonly string[];
  readonly errored: boolean;
  readonly recall: number;
  readonly fullHit: boolean;
  readonly quoteValid: boolean;
}

const rows: Row[] = [];
const started = performance.now();

for (const c of EXTRACTION_CASES) {
  const r = await extractFacts({
    model,
    log,
    clock,
    store,
    userId: 'u-eval',
    userText: c.text,
    existing: [],
  });
  const facts = r.facts.map((f) => f.content);
  const errored = r.skippedReason !== undefined && r.skippedReason.startsWith('提取失败');
  const matched = c.expected.filter((k) => facts.some((f) => f.includes(k)));
  const extra = facts.filter((f) => !c.expected.some((k) => f.includes(k)));
  const recall = c.expected.length === 0 ? 0 : matched.length / c.expected.length;
  const fullHit = c.expected.length > 0 && matched.length === c.expected.length;
  const quoteValid = r.facts.every((f) => quoteAppearsIn(f.quote, c.text));

  rows.push({
    id: c.id,
    category: c.category,
    expected: c.expected,
    facts,
    matched,
    extra,
    errored,
    recall,
    fullHit,
    quoteValid,
  });

  const mark = c.expected.length === 0 ? (facts.length === 0 ? '✓' : '✗') : fullHit ? '✓' : '✗';
  console.log(
    `${mark} ${c.id} [${c.category}] facts=${facts.length} ` +
      `recall=${c.expected.length === 0 ? '—' : `${matched.length}/${c.expected.length}`} ` +
      `expected=${c.expected.join('|') || '（无）'} ` +
      `got=${facts.join(' | ').slice(0, 140) || '（空）'}` +
      (r.skippedReason !== undefined ? `  [${r.skippedReason}]` : ''),
  );
}

const positives = rows.filter((r) => r.expected.length > 0 && !r.errored);
const negatives = rows.filter((r) => r.expected.length === 0 && !r.errored);
const fullHits = positives.filter((r) => r.fullHit).length;
const avgRecall =
  positives.length === 0 ? 0 : positives.reduce((n, r) => n + r.recall, 0) / positives.length;
const totalFacts = positives.reduce((n, r) => n + r.facts.length, 0);
const extraFacts = positives.reduce((n, r) => n + r.extra.length, 0);
const falseExtractions = negatives.filter((r) => r.facts.length > 0).length;
const quoteInvalid = rows.filter((r) => !r.quoteValid).length;
const errored = rows.filter((r) => r.errored).length;

console.log(
  JSON.stringify(
    {
      cases: rows.length,
      positives: positives.length,
      negatives: negatives.length,
      fullHit: fullHits,
      fullHitRate: Number((fullHits / Math.max(1, positives.length)).toFixed(3)),
      avgKeyRecall: Number(avgRecall.toFixed(3)),
      avgFactsPerPositive: Number((totalFacts / Math.max(1, positives.length)).toFixed(2)),
      extraFacts,
      negativeFalseExtractions: falseExtractions,
      negativeFalseExtractionRate: Number(
        (falseExtractions / Math.max(1, negatives.length)).toFixed(3),
      ),
      quoteInvalid,
      errored,
      elapsedMs: Math.round(performance.now() - started),
    },
    null,
    2,
  ),
);
