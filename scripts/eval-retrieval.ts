/**
 * 语义召回 A/B 评测：字面 / 向量 / 向量+LLM精排
 *
 * 运行：
 *   node --env-file-if-exists=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-retrieval.ts
 *
 * ⚠️ 会真实调用本地 bge 和 DeepSeek 精排；模型/API key 缺失时直接报错，不静默造假数据。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { env, pipeline } from '@huggingface/transformers';

import { deepSeekConfigFromEnv, DeepSeekModel } from '../src/adapters/model/deepseek.js';
import { loadEnvFile } from '../src/core/config/env.js';
import type { MemoryEntry } from '../src/core/memory/types.js';
import { recall, type ScoredMemory } from '../src/core/memory/recall.js';
import { rerankRecall } from '../src/core/memory/rerank.js';
import { SeededRandom } from '../src/core/ports/clock.js';

loadEnvFile();

const ROOT = process.cwd();
const MODEL_ROOT = join(ROOT, '.butler-data', 'models');
const T0 = 1_760_000_000_000;

const DATA: readonly { readonly id: string; readonly text: string; readonly hard?: boolean }[] = [
  { id: 'allergy', text: '用户对花生严重过敏。', hard: true },
  { id: 'fatloss', text: '用户正在减脂期，需要控制油脂摄入。' },
  { id: 'thesis', text: '用户在做毕业设计，需要控制进度。' },
  { id: 'gym', text: '用户每周三晚上有健身课。' },
  { id: 'cilantro', text: '用户不吃香菜。' },
  { id: 'light', text: '用户喜欢清淡口味。' },
  { id: 'morning', text: '用户早上九点工作最专注。' },
  { id: 'weekend', text: '用户周末通常看纪录片放松。' },
  { id: 'ielts', text: '用户正在准备雅思考试。' },
  { id: 'interrupt', text: '用户不喜欢工作被打断。' },
  { id: 'excel', text: '用户常用 Excel 做销售报表。' },
  { id: 'late', text: '用户晚上十一点后不想被通知。' },
];

const QUERIES: readonly { readonly q: string; readonly expected: string | null }[] = [
  { q: '我想吃火锅。', expected: 'fatloss' },
  { q: '这个项目有点来不及了。', expected: 'thesis' },
  { q: '今晚做什么菜？', expected: 'allergy' },
  { q: '周末想去健身房。', expected: 'gym' },
  { q: '今天天气怎么样？', expected: null },
  { q: '推荐一家餐厅。', expected: 'light' },
  { q: '我早上效率高吗？', expected: 'morning' },
  { q: '周末有什么放松建议？', expected: 'weekend' },
  { q: '我最近在备考。', expected: 'ielts' },
  { q: '工作时间别烦我。', expected: 'interrupt' },
  { q: '做个销售报表。', expected: 'excel' },
  { q: '晚上别提醒我。', expected: 'late' },
  { q: '我对什么过敏？', expected: 'allergy' },
  { q: '想减脂但想吃肉。', expected: 'fatloss' },
  { q: '论文进度怎么安排？', expected: 'thesis' },
  { q: '健身课什么时候？', expected: 'gym' },
  { q: '香菜能放吗？', expected: 'cilantro' },
  { q: '清淡点的菜。', expected: 'light' },
  { q: '早上安排会议。', expected: 'morning' },
  { q: '周末看什么？', expected: 'weekend' },
  { q: '雅思怎么准备？', expected: 'ielts' },
  { q: '报表用什么工具？', expected: 'excel' },
  { q: '深夜通知。', expected: 'late' },
  { q: '花生油可以吗？', expected: 'allergy' },
  { q: '低油食谱。', expected: 'fatloss' },
  { q: '帮我写一段 Python 代码。', expected: null },
  { q: '今天股票行情怎么样？', expected: null },
  { q: '怎么修打印机？', expected: null },
  { q: '明天会下雨吗？', expected: null },
  { q: '推荐一款手机。', expected: null },
  { q: '给我讲个笑话。', expected: null },
  { q: '电脑蓝屏怎么办？', expected: null },
  { q: '附近有什么加油站？', expected: null },
];

function entry(id: string, text: string, hard = false): MemoryEntry {
  return {
    id,
    owner: { kind: 'butler', userId: 'u_eval' },
    memClass: hard ? 'global_constraint' : 'global_shared',
    kind: 'preference',
    content: text,
    confidence: 0.8,
    evidence: ['e1', 'e2'],
    fitness: 0.8,
    lifecycle: 'active',
    lastHitAt: T0 - 86_400_000,
    hitCount: 2,
    revivedCount: 0,
    scope: 'global',
    version: 1,
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 86_400_000,
    useCount: 2,
  };
}

const candidates = DATA.map((m) => entry(m.id, m.text, m.hard === true));
const hardIds = new Set(candidates.filter((m) => m.memClass === 'global_constraint').map((m) => m.id));

function soft(selected: readonly ScoredMemory[]): readonly string[] {
  return selected.filter((s) => s.memory.memClass !== 'global_constraint').map((s) => s.memory.id);
}

interface Metric {
  hit1: number;
  hit3: number;
  fp: number;
  hardHit: number;
  rerankCalls: number;
  rerankFallbacks: number;
  rerankLatencyMs: number;
  rerankInputTokens: number;
  rerankOutputTokens: number;
}

function empty(): Metric {
  return {
    hit1: 0,
    hit3: 0,
    fp: 0,
    hardHit: 0,
    rerankCalls: 0,
    rerankFallbacks: 0,
    rerankLatencyMs: 0,
    rerankInputTokens: 0,
    rerankOutputTokens: 0,
  };
}

function scoreOne(expected: string | null, selected: readonly ScoredMemory[], m: Metric): void {
  if (expected === null) {
    if (soft(selected).length > 0) m.fp += 1;
    return;
  }
  if (hardIds.has(expected)) {
    if (selected.some((s) => s.memory.id === expected)) m.hardHit += 1;
    return;
  }
  const ids = soft(selected);
  if (ids[0] === expected) m.hit1 += 1;
  if (ids.slice(0, 3).includes(expected)) m.hit3 += 1;
}

const modelFile = join(MODEL_ROOT, 'Xenova', 'bge-base-zh-v1.5', 'onnx', 'model_quantized.onnx');
if (!existsSync(modelFile)) {
  console.error(`模型不存在：${modelFile}`);
  process.exit(1);
}
env.localModelPath = MODEL_ROOT;
env.cacheDir = MODEL_ROOT;
env.allowRemoteModels = false;

const extractor = await pipeline('feature-extraction', 'Xenova/bge-base-zh-v1.5', { dtype: 'q8' });
const memoryVectors = (await extractor(
  candidates.map((m) => m.content),
  { pooling: 'mean', normalize: true },
)).tolist() as number[][];

const modelCfg = deepSeekConfigFromEnv();
if (modelCfg.apiKey.length === 0) {
  console.error('缺少 DEEPSEEK_API_KEY，无法评测精排');
  process.exit(1);
}
const model = new DeepSeekModel(modelCfg);

const literal = empty();
const vector = empty();
const reranked = empty();
const details: {
  readonly q: string;
  readonly expected: string | null;
  readonly literal: readonly string[];
  readonly vector: readonly string[];
  readonly reranked: readonly string[];
  readonly hardSatisfied: boolean;
}[] = [];

for (const { q, expected } of QUERIES) {
  const literalResult = recall({
    query: q,
    candidates,
    limit: 5,
    now: T0,
    random: new SeededRandom(42),
  });
  scoreOne(expected, literalResult.selected, literal);

  const qv = (await extractor([q], { pooling: 'mean', normalize: true })).tolist()[0] as number[];
  const sem = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const v = memoryVectors[i];
    if (m === undefined || v === undefined) continue;
    let dot = 0;
    for (let j = 0; j < qv.length; j++) dot += (qv[j] ?? 0) * (v[j] ?? 0);
    sem.set(m.id, dot);
  }
  const vectorResult = recall({
    query: q,
    candidates,
    limit: 5,
    now: T0,
    random: new SeededRandom(42),
    semantic: sem,
  });
  scoreOne(expected, vectorResult.selected, vector);

  let rerankSelected = vectorResult.selected;
  if (vectorResult.selected.length > 1 && sem.size > 0) {
    const rr = await rerankRecall({ model, query: q, candidates: vectorResult.selected });
    rerankSelected = rr.items;
    reranked.rerankCalls += 1;
    reranked.rerankLatencyMs += rr.latencyMs;
    if (rr.usage !== null) {
      reranked.rerankInputTokens += rr.usage.inputTokens;
      reranked.rerankOutputTokens += rr.usage.outputTokens;
    }
    if (!rr.used) reranked.rerankFallbacks += 1;
  }
  scoreOne(expected, rerankSelected, reranked);

  details.push({
    q,
    expected,
    literal: soft(literalResult.selected),
    vector: soft(vectorResult.selected),
    reranked: soft(rerankSelected),
    hardSatisfied: vectorResult.selected.some((s) => s.memory.memClass === 'global_constraint'),
  });
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${n}/${d} (${Math.round((n / d) * 100)}%)`;
}

const relevant = QUERIES.filter((x) => x.expected !== null).length;
const softRelevant = QUERIES.filter((x) => x.expected !== null && !hardIds.has(x.expected)).length;
const nulls = QUERIES.length - relevant;
const hardQueries = relevant - softRelevant;

console.log(`queries=${QUERIES.length} relevant=${relevant} softRelevant=${softRelevant} null=${nulls} hard=${hardQueries}`);
console.log('');
console.log('           top1(soft)      top3(soft)      false-positive(null)');
for (const [name, m] of [['literal', literal], ['vector', vector], ['rerank', reranked]] as const) {
  console.log(
    `${name.padEnd(10)} ${pct(m.hit1, softRelevant).padEnd(15)} ${pct(m.hit3, softRelevant).padEnd(15)} ${pct(m.fp, nulls)}`,
  );
}
console.log(`rerank calls=${reranked.rerankCalls} fallbacks=${reranked.rerankFallbacks}`);
console.log(
  `rerank latency=${reranked.rerankLatencyMs}ms ` +
    `tokens in=${reranked.rerankInputTokens} out=${reranked.rerankOutputTokens}`,
);
console.log(`hard-constraint queries satisfied: literal ${literal.hardHit}/${hardQueries}, vector ${vector.hardHit}/${hardQueries}, rerank ${reranked.hardHit}/${hardQueries}`);

console.log('');
for (const d of details) {
  const mark = d.expected === null
    ? d.vector.length === 0 ? '·' : '✗'
    : hardIds.has(d.expected)
      ? d.hardSatisfied ? '✓' : '✗'
      : d.vector[0] === d.expected ? '✓' : '✗';
  console.log(
    `${mark} ${d.q.padEnd(12)} exp=${String(d.expected).padEnd(9)} ` +
      `lit=[${d.literal.join(',')}] vec=[${d.vector.join(',')}] rr=[${d.reranked.join(',')}]`,
  );
}
