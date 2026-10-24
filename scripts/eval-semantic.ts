/**
 * 语义召回离线评测（不是产品运行时依赖）
 *
 * 目的：在接入 recall 前先测清楚
 *   · 语义 top1 是否比字面 top1 好
 *   · 相关/无关查询的分数分布有没有区分带
 *   · 候选阈值是否合理
 *
 * 运行：
 *   pnpm exec tsx scripts/eval-semantic.ts
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { env, pipeline } from '@huggingface/transformers';

import { isRelevant } from '../src/core/text/keywords.js';

const ROOT = process.cwd();
const MODEL_ROOT = join(ROOT, '.butler-data', 'models');
const MODEL_ID = 'Xenova/bge-base-zh-v1.5';

const MEMORIES: readonly { readonly id: string; readonly text: string }[] = [
  { id: 'allergy', text: '用户对花生严重过敏。' },
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

/** 期望命中；null 表示应该没有相关记忆。 */
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

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function literalTop(q: string): { id: string | null; hits: number } {
  const hits = MEMORIES.filter((m) => isRelevant(q, m.text));
  return { id: hits[0]?.id ?? null, hits: hits.length };
}

const modelFile = join(MODEL_ROOT, 'Xenova', 'bge-base-zh-v1.5', 'onnx', 'model_quantized.onnx');
if (!existsSync(modelFile)) {
  console.error(`模型不存在：${modelFile}`);
  process.exit(1);
}

env.localModelPath = MODEL_ROOT;
env.cacheDir = MODEL_ROOT;
env.allowRemoteModels = false;

const t0 = Date.now();
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const memoryVectors = (await extractor(
  MEMORIES.map((m) => m.text),
  { pooling: 'mean', normalize: true },
)).tolist() as number[][];

const rows: {
  readonly q: string;
  readonly expected: string | null;
  readonly semantic: string;
  readonly semanticScore: number;
  readonly literal: string | null;
  readonly literalScore: number;
  readonly literalHits: number;
}[] = [];

for (const { q, expected } of QUERIES) {
  const qv = (await extractor([q], { pooling: 'mean', normalize: true })).tolist()[0] as number[];
  let best = -1;
  let bestId = '';
  for (let i = 0; i < MEMORIES.length; i++) {
    const s = cosine(qv, memoryVectors[i] ?? []);
    if (s > best) {
      best = s;
      bestId = MEMORIES[i]?.id ?? '';
    }
  }
  const literal = literalTop(q);
  rows.push({
    q,
    expected,
    semantic: bestId,
    semanticScore: best,
    literal: literal.id,
    literalScore: bestId === literal.id ? best : 0,
    literalHits: literal.hits,
  });
}

let semanticHits = 0;
let literalHits = 0;
let evaluated = 0;
for (const r of rows) {
  if (r.expected === null) continue;
  evaluated++;
  if (r.semantic === r.expected) semanticHits++;
  if (r.literal === r.expected) literalHits++;
}

console.log(`model=${MODEL_ID} dim=${memoryVectors[0]?.length ?? 0} load+embed=${Date.now() - t0}ms`);
console.log(`queries=${rows.length} evaluated=${evaluated}`);
console.log(`semantic top1 hits=${semanticHits}/${evaluated}  literal top1 hits=${literalHits}/${evaluated}`);
console.log('');
for (const r of rows) {
  const mark = r.expected === null ? '·' : r.semantic === r.expected ? '✓' : '✗';
  console.log(
    `${mark} ${r.q.padEnd(12, ' ')} expected=${String(r.expected).padEnd(9)} ` +
      `semantic=${r.semantic.padEnd(9)} ${r.semanticScore.toFixed(3)} ` +
      `literal=${String(r.literal).padEnd(9)} hits=${r.literalHits}`,
  );
}

const relevant = rows.filter((r) => r.expected !== null).map((r) => r.semanticScore);
const irrelevant = rows.filter((r) => r.expected === null).map((r) => r.semanticScore);
console.log('');
console.log('semantic relevant score range:', Math.min(...relevant).toFixed(3), '—', Math.max(...relevant).toFixed(3));
console.log('semantic irrelevant score range:', irrelevant.length > 0 ? `${Math.min(...irrelevant).toFixed(3)} — ${Math.max(...irrelevant).toFixed(3)}` : '—');
for (const threshold of [0.3, 0.32, 0.34, 0.35, 0.36, 0.38, 0.4, 0.42, 0.45]) {
  const tp = rows.filter((r) => r.expected !== null && r.semanticScore >= threshold).length;
  const fp = rows.filter((r) => r.expected === null && r.semanticScore >= threshold).length;
  console.log(`threshold ${threshold.toFixed(2)}: relevant>=${tp}/${evaluated}, irrelevant>=${fp}`);
}
