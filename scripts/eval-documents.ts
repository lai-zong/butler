/**
 * 文档检索基线评测（30 条查询 / 8 个文档）
 *
 * ⚠️ 这是**检索**评测（hit@K / MRR），不是端到端问答。
 *    端到端 QA 需要模型生成答案并核对引用，不能用这里的 10/10 冒充。
 *
 * 运行：node --import tsx scripts/eval-documents.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DocumentStore } from '../src/core/documents/store.js';
import { EVAL_DOCUMENTS, EVAL_DOCUMENT_CASES } from './eval-documents-data.js';

const dir = await mkdtemp(join(tmpdir(), 'butler-doc-eval-'));
const store = new DocumentStore(join(dir, 'docs'));

for (const d of EVAL_DOCUMENTS) await store.ingest(d);

let hit1 = 0;
let hit3 = 0;
let covered = 0;
let mrr = 0;
const started = performance.now();

for (const [i, c] of EVAL_DOCUMENT_CASES.entries()) {
  const hits = await store.search(c.q, 3);
  const rank = hits.findIndex((h) => c.want.every((w) => h.text.includes(w)));
  if (rank === 0) hit1 += 1;
  if (rank >= 0 && rank < 3) {
    hit3 += 1;
    covered += 1;
    mrr += 1 / (rank + 1);
  }
  console.log(
    `${rank >= 0 ? '✓' : '✗'} ${i + 1}. ${c.q} → ` +
      (hits.length > 0
        ? `${hits[0]!.name} / ${hits[0]!.text.slice(0, 70).replace(/\n/g, ' ')}`
        : '无结果') +
      (rank < 0 ? `  期望包含 ${c.want.join(' + ')}` : ''),
  );
}

const total = EVAL_DOCUMENT_CASES.length;
console.log(
  JSON.stringify(
    {
      documents: EVAL_DOCUMENTS.length,
      cases: total,
      hit1,
      hit3,
      hitRate: Number((hit3 / total).toFixed(2)),
      mrr: Number((mrr / Math.max(1, covered)).toFixed(3)),
      elapsedMs: Math.round(performance.now() - started),
    },
    null,
    2,
  ),
);
await rm(dir, { recursive: true, force: true });
