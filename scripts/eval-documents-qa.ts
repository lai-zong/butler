/**
 * 文档端到端 QA 评测（30 题，真实模型）
 *
 * 与 eval-documents.ts 的区别：
 *   · eval-documents 只测“检索能否把正确片段排进前 K”；
 *   · 这里把检索结果喂给模型，要求**只根据资料回答 + 给出引用**，
 *     同时检查答案关键点与引用文档。
 *
 * 运行：
 *   node --env-file-if-exists=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-documents-qa.ts
 *
 * ⚠️ 这不是产品运行路径，只是质量评测；不把评测结果写进用户数据。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { DeepSeekModel, deepSeekConfigFromEnv } from '../src/adapters/model/deepseek.js';
import { DocumentStore, type DocumentHit } from '../src/core/documents/store.js';
import { msg } from '../src/core/ports/model.js';
import { EVAL_DOCUMENTS, EVAL_DOCUMENT_CASES } from './eval-documents-data.js';

const qaSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(z.string()).min(0).max(5),
});

const SYSTEM = `你是文档问答器。只能使用用户提供的资料回答；资料不足时明确说“无法从资料确认”，不要编造。
答案要简洁、直接；必须给出引用，citations 里写资料的文件名（不是编号）。
只输出 JSON：{"answer":"...","citations":["文件名"]}`;

function promptFor(question: string, hits: readonly DocumentHit[]): string {
  const rows = hits
    .map((h, i) => `[${i + 1}] ${h.name}\n${h.text.slice(0, 900)}`)
    .join('\n\n');
  return `问题：${question}\n\n资料：\n${rows || '（没有检索到资料）'}\n\n输出 JSON。`;
}

function expectedDocOf(want: readonly string[]): string | null {
  for (const d of EVAL_DOCUMENTS) {
    if (want.every((w) => d.text.includes(w))) return d.name;
  }
  return null;
}

const dir = await mkdtemp(join(tmpdir(), 'butler-doc-qa-'));
const store = new DocumentStore(join(dir, 'docs'));
for (const d of EVAL_DOCUMENTS) await store.ingest(d);
const model = new DeepSeekModel(deepSeekConfigFromEnv());

let retrievalHit = 0;
let answerHit = 0;
let citationHit = 0;
let bothHit = 0;
let errored = 0;
const started = performance.now();

for (const [i, c] of EVAL_DOCUMENT_CASES.entries()) {
  const expectedDoc = expectedDocOf(c.want);
  const hits = await store.search(c.q, 3);
  const retrieved =
    expectedDoc !== null && hits.some((h) => h.name === expectedDoc && c.want.every((w) => h.text.includes(w)));
  if (retrieved) retrievalHit += 1;

  let answer = '';
  let citations: readonly string[] = [];
  try {
    const r = await model.completeStructured({
      purpose: 'routing',
      schema: qaSchema,
      schemaName: 'DocumentAnswer',
      thinking: 'disabled',
      temperature: 0,
      maxOutputTokens: 600,
      messages: [msg.system(SYSTEM), msg.user(promptFor(c.q, hits))],
    });
    answer = r.value.answer;
    citations = r.value.citations;
  } catch (err) {
    errored += 1;
    answer = `（模型调用失败：${err instanceof Error ? err.message : String(err)}）`;
  }

  const answerKeys = c.answerKeys ?? c.want;
  const answerOk = answerKeys.every((w) => answer.includes(w));
  const citeOk = expectedDoc !== null && citations.some((x) => x.includes(expectedDoc));
  if (answerOk) answerHit += 1;
  if (citeOk) citationHit += 1;
  if (answerOk && citeOk) bothHit += 1;

  console.log(
    `${answerOk && citeOk ? '✓' : '✗'} ${i + 1}. ${c.q}\n` +
      `   retrieved=${retrieved ? 'yes' : 'no'} expected=${expectedDoc ?? '—'}\n` +
      `   answer=${answer.replace(/\n/g, ' ').slice(0, 140)}\n` +
      `   citations=${citations.join(',') || '（空）'}`,
  );
}

const total = EVAL_DOCUMENT_CASES.length;
console.log(
  JSON.stringify(
    {
      cases: total,
      retrievalHit,
      answerHit,
      citationHit,
      bothHit,
      answerRate: Number((answerHit / total).toFixed(3)),
      citationRate: Number((citationHit / total).toFixed(3)),
      bothRate: Number((bothHit / total).toFixed(3)),
      errored,
      elapsedMs: Math.round(performance.now() - started),
    },
    null,
    2,
  ),
);

await rm(dir, { recursive: true, force: true });
