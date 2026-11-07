'use client';

/**
 * 设置 → 文档库
 *
 * 通用文档能力的前端入口：
 *   上传 → 提取 → 入库 → 检索 → 查看片段 → 选择性“记住这一条”。
 *
 * ⚠️ 文档正文默认只做检索；只有用户明确点“记住这一段”才写入记忆并直接生效。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import type {
  DocumentDetailDto,
  DocumentHitDto,
  DocumentIngestResponse,
  DocumentSummaryDto,
  DocumentsResponse,
  KnowledgeRetrievalMode,
} from '../lib/types.js';
import { KnowledgeRetrievalSettings } from './KnowledgeRetrievalSettings';

const DOMAINS = [
  { value: 'life', label: '生活' },
  { value: 'health', label: '健康' },
  { value: 'study', label: '学习' },
  { value: 'work', label: '工作' },
  { value: 'code', label: '代码' },
] as const;

const CLASS_OPTIONS = [
  { value: 'domain', label: '领域记忆' },
  { value: 'global_shared', label: '全局共享' },
] as const;

/** 最近一次检索的模式与降级信息，只用于结果区的一行状态。 */
interface SearchMeta {
  readonly mode: KnowledgeRetrievalMode;
  readonly fallbackReason: string | null;
  readonly rerankUsed: boolean;
}

function searchStatus(meta: SearchMeta): { readonly text: string; readonly warn: boolean } {
  if (meta.fallbackReason !== null) return { text: meta.fallbackReason, warn: true };
  const label = meta.mode === 'hybrid' ? '混合检索' : meta.mode === 'semantic' ? '纯语义检索' : '字面检索';
  return { text: meta.rerankUsed ? `${label} · 已重排` : label, warn: false };
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsPanel({
  notify,
}: {
  readonly notify: (text: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}): JSX.Element {
  const [docs, setDocs] = useState<readonly DocumentSummaryDto[]>([]);
  const [hits, setHits] = useState<readonly DocumentHitDto[]>([]);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retrievalOpen, setRetrievalOpen] = useState(false);
  const [rememberScope, setRememberScope] = useState<'domain' | 'global_shared'>('domain');
  const [rememberDomain, setRememberDomain] = useState('life');
  const [rememberingChunk, setRememberingChunk] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const data = await fetchJson<DocumentsResponse>('/api/documents');
      setDocs(data.documents ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function search(): Promise<void> {
    const q = query.trim();
    if (q.length === 0) {
      setHits([]);
      setSearchMeta(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const data = await fetchJson<DocumentsResponse>(`/api/documents?q=${encodeURIComponent(q)}`);
      setHits(data.hits ?? []);
      setSearchMeta(
        data.mode === undefined
          ? null
          : {
              mode: data.mode,
              fallbackReason: data.fallbackReason ?? null,
              rerankUsed: data.rerankUsed === true,
            },
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  async function upload(files: readonly File[]): Promise<void> {
    const file = files[0];
    if (file === undefined) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const extracted = await fetchJson<{ text?: string; error?: string }>('/api/attachments/extract', {
        method: 'POST',
        body: form,
      });
      if (typeof extracted.text !== 'string' || extracted.text.trim().length === 0) {
        throw new Error(extracted.error ?? '没有提取到文本');
      }
      const ingested = await postJson<DocumentIngestResponse>('/api/documents', {
        name: file.name,
        text: extracted.text,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      });
      if (typeof ingested.indexWarning === 'string' && ingested.indexWarning.length > 0) {
        notify(
          `「${file.name}」已加入文档库，但知识库索引更新失败：${ingested.indexWarning}`,
          'warning',
        );
      } else {
        notify(`「${file.name}」已加入文档库，可以检索和引用。`, 'success');
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function open(doc: DocumentSummaryDto): Promise<void> {
    setDetailLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ document: DocumentDetailDto }>(
        `/api/documents/${encodeURIComponent(doc.id)}`,
      );
      setDetail(data.document);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }

  async function remove(doc: DocumentSummaryDto): Promise<void> {
    if (!window.confirm(`删除「${doc.name}」？删除后检索不到这份文档。`)) return;
    try {
      await fetchJson(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
      notify('文档已删除。', 'default');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remember(chunk: { readonly index: number; readonly text: string }): Promise<void> {
    if (detail === null) return;
    setRememberingChunk(`${detail.id}:${chunk.index}`);
    try {
      await postJson(`/api/documents/${encodeURIComponent(detail.id)}/remember`, {
        content: chunk.text.slice(0, 500),
        memClass: rememberScope,
        ...(rememberScope === 'domain' ? { domain: rememberDomain } : {}),
      });
      notify('已记住这一段；这是你明确选择的记忆，已直接生效。', 'success');
    } catch (err) {
      notify(errorMessage(err), 'warning');
    } finally {
      setRememberingChunk(null);
    }
  }

  const hitStatus = searchMeta === null ? null : searchStatus(searchMeta);

  return (
    <section className="panel settings-panel doc-panel">
      <SectionHeading
        title="文档库"
        description="PDF / Word / Excel / CSV / 文本统一入库；按片段检索，回答带出处。"
        actions={
          <div className="doc-actions">
            <Badge tone="accent">{formatNumber(docs.length)} 份</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setRetrievalOpen(true)}
            >
              <Icon name="settings" size={13} /> 检索设置
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <Icon name="upload" size={13} /> {uploading ? '提取中…' : '上传文档'}
            </button>
          </div>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.json"
        hidden
        onChange={(e) => {
          if (e.target.files !== null) void upload(Array.from(e.target.files));
          e.target.value = '';
        }}
      />

      <div className="doc-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
          placeholder="搜文档内容，例如：LDL、付款期限、schema 变更"
          aria-label="检索文档"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void search()}>
          {searching ? '检索中…' : '检索'}
        </button>
        {query.trim().length > 0 && (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setQuery('');
              setHits([]);
              setSearchMeta(null);
            }}
          >
            清除
          </button>
        )}
      </div>
      <p className="doc-note">
        文档内容默认只用于检索，不会自动写进记忆；回答会带文档名与片段号。
      </p>

      {loading ? (
        <Skeleton rows={5} height={16} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : (
        <>
          {hits.length > 0 && (
            <div className="doc-hits">
              <div className="doc-hits-head">
                <p className="mini-label">检索结果</p>
                {hitStatus !== null && (
                  <span className={`doc-search-mode${hitStatus.warn ? ' is-warn' : ''}`}>
                    {hitStatus.text}
                  </span>
                )}
              </div>
              {hits.map((h) => (
                <button
                  key={`${h.documentId}-${h.chunkIndex}`}
                  type="button"
                  className="doc-hit"
                  onClick={() => {
                    const doc = docs.find((d) => d.id === h.documentId);
                    if (doc !== undefined) void open(doc);
                  }}
                >
                  <span className="doc-hit-name">
                    {h.name} <em>片段 {h.chunkIndex + 1}</em>
                  </span>
                  <span className="doc-hit-text">{h.text.slice(0, 180)}</span>
                </button>
              ))}
            </div>
          )}

          {docs.length === 0 ? (
            <div className="doc-empty">
              <Icon name="file" size={22} />
              <strong>还没有文档</strong>
              <p>上传一份报告、合同或表格，之后就能按内容检索并引用。</p>
            </div>
          ) : (
            <div className="doc-list">
              {docs.map((doc) => (
                <div key={doc.id} className="doc-row">
                  <span className="doc-icon">
                    <Icon name="file" size={17} />
                  </span>
                  <button type="button" className="doc-main" onClick={() => void open(doc)}>
                    <strong>{doc.name}</strong>
                    <span>
                      {formatNumber(doc.chunkCount)} 个片段 · {bytes(doc.size)} ·{' '}
                      {formatDateTime(doc.createdAt)}
                    </span>
                  </button>
                  <div className="doc-row-actions">
                    <button type="button" className="text-btn" onClick={() => void open(doc)}>
                      查看片段
                    </button>
                    <button type="button" className="text-btn doc-del" onClick={() => void remove(doc)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <Modal
        open={detail !== null || detailLoading}
        onClose={() => {
          setDetail(null);
          setDetailLoading(false);
        }}
        title={detail?.name ?? '正在读取文档…'}
        description={
          detail !== null
            ? `${formatNumber(detail.chunks.length)} 个片段 · ${bytes(detail.size)}`
            : undefined
        }
        variant="wide"
      >
        {detailLoading ? (
          <Skeleton rows={6} height={16} />
        ) : detail !== null ? (
          <div className="doc-detail">
            <div className="doc-remember-bar">
              <span>记住片段时归入</span>
              <select
                value={rememberScope}
                onChange={(e) => setRememberScope(e.target.value as 'domain' | 'global_shared')}
                aria-label="记忆范围"
              >
                {CLASS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {rememberScope === 'domain' && (
                <select
                  value={rememberDomain}
                  onChange={(e) => setRememberDomain(e.target.value)}
                  aria-label="记忆领域"
                >
                  {DOMAINS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              )}
              <span className="doc-remember-hint">明确选择，直接生效</span>
            </div>
            {detail.chunks.map((chunk) => (
              <article key={chunk.id} className="doc-chunk">
                <header>
                  <span className="mono">片段 {chunk.index + 1}</span>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => void remember(chunk)}
                    disabled={rememberingChunk !== null}
                  >
                    {rememberingChunk === `${detail.id}:${chunk.index}` ? '加入中…' : '记住这一段'}
                  </button>
                </header>
                <p>{chunk.text}</p>
              </article>
            ))}
          </div>
        ) : null}
      </Modal>

      <KnowledgeRetrievalSettings
        open={retrievalOpen}
        onClose={() => setRetrievalOpen(false)}
        notify={notify}
      />
    </section>
  );
}
