/**
 * 通用文档库（与领域无关）
 *
 * 目标不是“体检报告专用解析”，而是所有文档都走同一条路：
 *   文本 → 分块 → 落盘 → 检索 → 带出处返回。
 *
 * ⚠️ 文档内容默认**只用于检索**，不自动写入记忆；
 *    稳定事实需要单独走记忆候选/用户确认。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DocumentChunk {
  readonly id: string;
  readonly index: number;
  readonly text: string;
}

export interface DocumentRecord {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly chunks: readonly DocumentChunk[];
}

export interface DocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly createdAt: number;
  readonly chunkCount: number;
}

export interface DocumentHit {
  readonly documentId: string;
  readonly name: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly score: number;
}

const MAX_TEXT = 2_000_000;
const MAX_CHUNKS = 500;
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 120;

function chunkText(text: string): readonly string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = '';
  };
  for (const p of paragraphs) {
    if (current.length + p.length + 2 <= CHUNK_CHARS) {
      current += `${current.length > 0 ? '\n\n' : ''}${p}`;
      continue;
    }
    flush();
    if (p.length <= CHUNK_CHARS) {
      current = p;
      continue;
    }
    // 超长段落：滑窗切分，保留少量重叠，避免关键句被切断。
    for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
      chunks.push(p.slice(i, i + CHUNK_CHARS));
      if (i + CHUNK_CHARS >= p.length) break;
    }
  }
  flush();
  return chunks.slice(0, MAX_CHUNKS);
}

function queryTokens(query: string): readonly string[] {
  const out = new Set<string>();
  const text = query.toLowerCase();
  for (const m of text.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
  return [...out];
}

function scoreChunk(text: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    let count = 0;
    let idx = 0;
    while (true) {
      const at = hay.indexOf(t, idx);
      if (at < 0) break;
      count++;
      idx = at + t.length;
      if (count > 8) break;
    }
    if (count > 0) score += 1 + Math.log(count);
  }
  return score;
}

export class DocumentStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileOf(id: string): string {
    if (!/^doc_[A-Za-z0-9-]+$/.test(id)) throw new Error('非法文档 id');
    return join(this.dir, `${id}.json`);
  }

  private async read(id: string): Promise<DocumentRecord | null> {
    try {
      const raw = await readFile(this.fileOf(id), 'utf8');
      const parsed = JSON.parse(raw) as DocumentRecord;
      if (typeof parsed.id !== 'string' || !Array.isArray(parsed.chunks)) return null;
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async ingest(args: {
    readonly name: string;
    readonly mime?: string;
    readonly size?: number;
    readonly text: string;
  }): Promise<{ readonly document: DocumentSummary; readonly duplicate: boolean }> {
    const name = args.name.trim();
    if (name.length === 0) throw new Error('文档名不能为空');
    const text = args.text;
    if (text.trim().length === 0) throw new Error('文档没有可检索的文本');
    if (text.length > MAX_TEXT) throw new Error(`文档文本超过 ${MAX_TEXT} 字符上限`);

    await mkdir(this.dir, { recursive: true });
    const sha256 = createHash('sha256').update(text).digest('hex');
    const existing = (await this.list()).find((d) => d.sha256 === sha256 && d.name === name);
    if (existing !== undefined) {
      const doc = await this.read(existing.id);
      if (doc !== null) return { document: this.summaryOf(doc), duplicate: true };
    }

    const pieces = chunkText(text);
    if (pieces.length === 0) throw new Error('文档没有可检索的文本');
    const id = `doc_${randomUUID()}`;
    const record: DocumentRecord = {
      id,
      name,
      mime: args.mime ?? 'text/plain',
      size: args.size ?? Buffer.byteLength(text, 'utf8'),
      sha256,
      createdAt: this.now(),
      chunks: pieces.map((t, index) => ({ id: `${id}_${index}`, index, text: t })),
    };
    const dest = this.fileOf(id);
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(tmp, dest);
    return { document: this.summaryOf(record), duplicate: false };
  }

  async list(): Promise<readonly (DocumentSummary & { readonly sha256: string })[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      const docs: (DocumentSummary & { sha256: string })[] = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const id = e.name.slice(0, -5);
        const doc = await this.read(id);
        if (doc !== null) docs.push({ ...this.summaryOf(doc), sha256: doc.sha256 });
      }
      docs.sort((a, b) => b.createdAt - a.createdAt);
      return docs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async get(id: string): Promise<DocumentRecord | null> {
    return this.read(id);
  }

  async remove(id: string): Promise<boolean> {
    const doc = await this.read(id);
    if (doc === null) return false;
    await rm(this.fileOf(id), { force: true });
    return true;
  }

  async search(query: string, limit = 5): Promise<readonly DocumentHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const tokens = queryTokens(q);
    if (tokens.length === 0) return [];
    const docs = await this.list();
    const hits: DocumentHit[] = [];
    for (const summary of docs) {
      const doc = await this.read(summary.id);
      if (doc === null) continue;
      for (const chunk of doc.chunks) {
        const score = scoreChunk(chunk.text, tokens);
        if (score <= 0) continue;
        hits.push({
          documentId: doc.id,
          name: doc.name,
          chunkIndex: chunk.index,
          text: chunk.text,
          score,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));
    return hits.slice(0, Math.max(1, Math.min(limit, 20)));
  }

  private summaryOf(doc: DocumentRecord): DocumentSummary {
    return {
      id: doc.id,
      name: doc.name,
      mime: doc.mime,
      size: doc.size,
      createdAt: doc.createdAt,
      chunkCount: doc.chunks.length,
    };
  }
}
