/**
 * 记忆召回统一评测（dev / test 分离）
 *
 * 目的：把“语义阈值 / top-k 补充 / 精排过滤”放在同一套可复现的数据上比较，
 * 而不是在三份重叠脚本里各自报一个互相矛盾的数字。
 *
 * 运行：
 *   node --env-file-if-exists=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-recall.ts --split=dev
 *   node --env-file-if-exists=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-recall.ts --split=test --mode=topk-rerank
 *
 * 约束：
 *   · dev 用来调参数；test 只用于最终验收。
 *   · 负例只允许硬约束出现，任何软记忆都算误召回。
 *   · 不做按领域/按查询的特判；这里只测通用召回。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DeepSeekModel, deepSeekConfigFromEnv } from '../src/adapters/model/deepseek.js';
import type { ModelPort } from '../src/core/ports/model.js';
import { LocalBgeEmbedding } from '../src/adapters/embedding/localBge.js';
import { retrievalConfig, loadEnvFile } from '../src/core/config/env.js';
import { EventLog } from '../src/core/events/log.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { recall, type ScoredMemory } from '../src/core/memory/recall.js';
import { rerankRecall } from '../src/core/memory/rerank.js';
import { SemanticIndex } from '../src/core/memory/semantic.js';
import { FixedClock, SeededRandom } from '../src/core/ports/clock.js';
import { RECALL_NEGATIVES, RECALL_POSITIVES, RECALL_SEEDS, type RecallCase, type RecallSplit } from './eval-recall-data.js';

type Mode = 'literal' | 'semantic' | 'topk' | 'topk-rerank';
const ALL_MODES: readonly Mode[] = ['literal', 'semantic', 'topk', 'topk-rerank'];
const ROOT = process.cwd();
const NOW = 1_760_000_000_000;

loadEnvFile(ROOT);

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const splitArg = arg('split', 'dev') as RecallSplit | 'all';
const modeArg = arg('mode', 'all');
// 与生产 RECALL_LIMIT 对齐；否则评测会低估“多一个名额”的价值。
const limit = Number(arg('limit', '8'));
const threshold = Number(arg('semantic-threshold', String(retrievalConfig.semanticThreshold)));
const topK = Number(arg('topk', String(retrievalConfig.semanticTopK)));
const floor = Number(arg('floor', String(retrievalConfig.semanticFloor)));
const rerankMin = Number(arg('rerank-min', String(retrievalConfig.rerankMinRelevance)));
const verbose = process.argv.includes('--verbose');
const jsonOut = process.argv.includes('--json');

function selectedSplit(s: RecallSplit): boolean {
  return splitArg === 'all' || splitArg === s;
}

function cases(): readonly RecallCase[] {
  const positives = RECALL_POSITIVES.filter((c) => selectedSplit(c.split));
  const negatives = RECALL_NEGATIVES.filter((c) => selectedSplit(c.split));
  return [...positives, ...negatives];
}

function makeStore(): MemoryStore {
  const log = new EventLog('eval-recall');
  const clock = new FixedClock(NOW);
  const store = new MemoryStore(log, clock, 'eval-user');
  for (const s of RECALL_SEEDS) {
    const r = store.create(
      { kind: 'butler', userId: 'eval-user' },
      {
        id: s.id,
        memClass: s.memClass,
        kind: s.kind,
        content: s.content,
        confidence: 0.9,
        evidence: ['eval:seed'],
        lifecycle: 'active',
        ...(s.domain !== undefined ? { domain: s.domain } : {}),
      },
    );
    if (!r.ok) throw new Error(`seed ${s.id} failed: ${r.reason}`);
  }
  return store;
}

function softIds(selected: readonly ScoredMemory[]): readonly string[] {
  return selected.filter((s) => s.memory.memClass !== 'global_constraint').map((s) => s.memory.id);
}

interface Metrics {
  positives: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  covered: number;
  hardExpected: number;
  hardHit: number;
  negatives: number;
  falsePositives: number;
  rerankCalls: number;
  rerankFallbacks: number;
  rerankInputTokens: number;
  rerankOutputTokens: number;
  rerankLatencyMs: number;
  elapsedMs: number;
}

function emptyMetrics(): Metrics {
  return {
    positives: 0,
    hit1: 0,
    hit3: 0,
    hit5: 0,
    mrr: 0,
    covered: 0,
    hardExpected: 0,
    hardHit: 0,
    negatives: 0,
    falsePositives: 0,
    rerankCalls: 0,
    rerankFallbacks: 0,
    rerankInputTokens: 0,
    rerankOutputTokens: 0,
    rerankLatencyMs: 0,
    elapsedMs: 0,
  };
}

function scorePositive(c: RecallCase, selected: readonly ScoredMemory[], m: Metrics): void {
  const ids = selected.map((s) => s.memory.id);
  const expected = c.expected;
  const hardExpected = expected.filter(
    (id) => RECALL_SEEDS.find((s) => s.id === id)?.memClass === 'global_constraint',
  );
  const softExpected = expected.filter((id) => !hardExpected.includes(id));

  /**
   * ⚠️ 排名只在**软记忆**里算：硬约束被设计成永远在最前，
   *    如果把硬约束算进 hit@1，所有“正常问题”都会被它挡住，
   *    指标会退化成 5%，看不出召回质量。硬约束单独统计。
   */
  if (softExpected.length > 0) {
    m.positives += 1;
    const softIds = selected
      .filter((s) => s.memory.memClass !== 'global_constraint')
      .map((s) => s.memory.id);
    const rank = softIds.findIndex((id) => softExpected.includes(id));
    if (rank === 0) m.hit1 += 1;
    if (rank >= 0 && rank < 3) m.hit3 += 1;
    if (rank >= 0 && rank < 5) m.hit5 += 1;
    if (rank >= 0) {
      m.mrr += 1 / (rank + 1);
      m.covered += 1;
    }
  }

  if (hardExpected.length > 0) {
    m.hardExpected += 1;
    if (hardExpected.some((id) => ids.includes(id))) m.hardHit += 1;
  }
}

function scoreNegative(selected: readonly ScoredMemory[], m: Metrics, verboseLine: string): void {
  m.negatives += 1;
  const soft = softIds(selected);
  if (soft.length > 0) {
    m.falsePositives += 1;
    if (verbose) console.log(`  ✗ ${verboseLine} → 误召回 ${soft.join(',')}`);
  } else if (verbose) {
    console.log(`  ✓ ${verboseLine} → 只有硬约束 / 空`);
  }
}

function fmtPct(n: number, d: number): string {
  return d === 0 ? '—' : `${n}/${d} (${((n / d) * 100).toFixed(0)}%)`;
}

async function runMode(
  mode: Mode,
  data: readonly RecallCase[],
  store: MemoryStore,
  index: SemanticIndex | null,
  rerankModel: ModelPort | null,
): Promise<Metrics> {
  const m = emptyMetrics();
  const started = performance.now();

  for (const c of data) {
    const isNegative = c.expected.length === 0;
    let semantic: ReadonlyMap<string, number> | undefined;
    if (mode !== 'literal') {
      if (index === null) throw new Error('semantic 模式需要 embedding 模型');
      semantic = await index.scores(c.text, store.all());
    }

    let selected: readonly ScoredMemory[];
    if (mode === 'literal') {
      selected = recall({
        query: c.text,
        candidates: store.all(),
        limit,
        now: NOW,
        random: new SeededRandom(1),
      }).selected;
    } else if (mode === 'semantic') {
      selected = recall({
        query: c.text,
        candidates: store.all(),
        limit,
        now: NOW,
        random: new SeededRandom(1),
        semantic,
        semanticThreshold: threshold,
      }).selected;
    } else if (mode === 'topk') {
      selected = recall({
        query: c.text,
        candidates: store.all(),
        limit,
        now: NOW,
        random: new SeededRandom(1),
        semantic,
        semanticThreshold: threshold,
        semanticTopK: topK,
        semanticFloor: floor,
      }).selected;
    } else {
      if (rerankModel === null) throw new Error('topk-rerank 模式需要真实模型');
      const base = recall({
        query: c.text,
        candidates: store.all(),
        limit,
        now: NOW,
        random: new SeededRandom(1),
        semantic,
        semanticThreshold: threshold,
        semanticTopK: topK,
        semanticFloor: floor,
      });
      selected = base.selected;
      if (semantic !== undefined && semantic.size > 0 && selected.length > 1) {
        const rr = await rerankRecall({
          model: rerankModel,
          query: c.text,
          candidates: selected,
          filter: true,
          minRelevance: rerankMin,
        });
        m.rerankCalls += 1;
        m.rerankLatencyMs += rr.latencyMs;
        if (rr.usage !== null) {
          m.rerankInputTokens += rr.usage.inputTokens;
          m.rerankOutputTokens += rr.usage.outputTokens;
        }
        if (rr.used) {
          selected = rr.items;
        } else {
          m.rerankFallbacks += 1;
          // 精排失败：回退到“只过阈值”的语义路径，不保留 top-k 噪声。
          selected = recall({
            query: c.text,
            candidates: store.all(),
            limit,
            now: NOW,
            random: new SeededRandom(1),
            semantic,
            semanticThreshold: threshold,
          }).selected;
        }
      }
    }

    const ids = selected.map((s) => s.memory.id);
    if (verbose) {
      console.log(
        `  ${isNegative ? 'NEG' : 'POS'} [${c.split}/${c.id}] ${c.text} → ${ids.join(',') || '（空）'}` +
          (!isNegative && !ids.some((id) => c.expected.includes(id)) ? `  期望 ${c.expected.join('|')}` : ''),
      );
    }
    if (isNegative) scoreNegative(selected, m, `[${c.split}/${c.id}] ${c.text}`);
    else scorePositive(c, selected, m);
  }

  m.elapsedMs = Math.round(performance.now() - started);
  return m;
}

function printMode(mode: Mode, m: Metrics): void {
  console.log(
    `\n[${mode}] split=${splitArg} limit=${limit}` +
      (mode === 'semantic' ? ` threshold=${threshold}` : '') +
      (mode === 'topk' || mode === 'topk-rerank' ? ` topK=${topK} floor=${floor}` : '') +
      (mode === 'topk-rerank' ? ` rerankMin=${rerankMin}` : ''),
  );
  console.log(
    `  正例 hit@1=${fmtPct(m.hit1, m.positives)}  hit@3=${fmtPct(m.hit3, m.positives)}  ` +
      `hit@5=${fmtPct(m.hit5, m.positives)}  MRR=${m.positives === 0 ? '—' : (m.mrr / m.positives).toFixed(3)}  ` +
      `覆盖=${fmtPct(m.covered, m.positives)}`,
  );
  console.log(
    `  负例 误召回=${fmtPct(m.falsePositives, m.negatives)}  ` +
      `硬约束 ${fmtPct(m.hardHit, m.hardExpected)}`,
  );
  if (mode === 'topk-rerank') {
    console.log(
      `  精排 calls=${m.rerankCalls} fallback=${m.rerankFallbacks} ` +
        `tokens=${m.rerankInputTokens}/${m.rerankOutputTokens} latency=${m.rerankLatencyMs}ms`,
    );
  }
  console.log(`  耗时 ${m.elapsedMs}ms`);
}

async function main(): Promise<void> {
  const data = cases();
  if (data.length === 0) throw new Error(`没有 split=${splitArg} 的评测数据`);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit 必须是正数');

  const modes: readonly Mode[] =
    modeArg === 'all' ? ALL_MODES : ALL_MODES.filter((m) => m === modeArg);
  if (modes.length === 0) throw new Error(`未知 mode：${modeArg}`);

  const store = makeStore();
  const needsSemantic = modes.some((m) => m !== 'literal');
  const modelPath = join(ROOT, '.butler-data', 'models', 'Xenova', 'bge-base-zh-v1.5');
  if (needsSemantic && !existsSync(join(modelPath, 'onnx', 'model_quantized.onnx'))) {
    throw new Error(`缺少本地 embedding 模型：${modelPath}`);
  }
  const embedding = needsSemantic ? new LocalBgeEmbedding(join(ROOT, '.butler-data', 'models')) : null;
  if (embedding !== null && !embedding.isAvailable()) {
    throw new Error('embedding 模型文件不完整');
  }
  const index = embedding !== null ? new SemanticIndex(embedding) : null;

  let rerankModel: ModelPort | null = null;
  if (modes.includes('topk-rerank')) {
    try {
      rerankModel = new DeepSeekModel(deepSeekConfigFromEnv());
    } catch (err) {
      throw new Error(
        `topk-rerank 需要真实模型：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const report: Record<string, Metrics> = {};
  for (const mode of modes) {
    const m = await runMode(mode, data, store, index, rerankModel);
    report[mode] = m;
    printMode(mode, m);
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          split: splitArg,
          limit,
          threshold,
          topK,
          floor,
          rerankMin,
          modes: report,
          model: rerankModel?.describe() ?? null,
        },
        null,
        2,
      ),
    );
  }
}

await main();
