'use client';

/**
 * 专注空间的独立文档阅读器。
 *
 * ★ 不依附日程：右侧有自己的入口与窗口，日程抽屉保持纯日程。
 * ★ 不再浏览工作区：只通过系统选择框打开指定文件。
 * ★ 打开记录只包含文件名、路径与时间，存 localStorage；它不授予再次读取的权限，
 *   所以要再看一次仍然需要重新选择文件 —— 记录本身不绕过原生选择框。
 * ★ 文本/Markdown 可编辑；docx / xlsx / PDF 只读。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ApiError, errorMessage, fetchJson, postJson, putJson } from '../lib/api.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import type { ToastMessage } from '../lib/types.js';

type Notify = (text: string, tone?: ToastMessage['tone']) => void;

/**
 * 文档阅读器的固定作用域。
 *
 * ★ 不依赖当前对话：用户不必先建会话就能直接打开文件。
 * ★ 句柄按这个独立作用域登记，不会混进任何对话的 AI 文件授权。
 */
const DOCUMENT_SCOPE = 'focus-documents';

interface ExternalFileDto {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: 'text' | 'image' | 'pdf' | 'office' | 'unsupported';
  readonly size: number;
  readonly mtimeMs: number;
  readonly editable: boolean;
  readonly etag: string;
  readonly sessionId: string;
}

type ExternalPreviewResponse =
  | { readonly ok: boolean; readonly kind: 'image' | 'pdf'; readonly url: string }
  | {
      readonly ok: boolean;
      readonly kind: 'table';
      readonly sheet: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
      readonly note: string;
    }
  | {
      readonly ok: boolean;
      readonly kind: 'text';
      readonly text: string;
      readonly etag: string;
    }
  | {
      readonly ok: boolean;
      readonly kind: 'text';
      readonly text: string;
      readonly note: string;
    };

interface ExternalSaveResponse {
  readonly ok: boolean;
  readonly etag: string;
  readonly mtimeMs: number;
}

interface ExternalMetaResponse {
  readonly ok: boolean;
  readonly file: ExternalFileDto;
}

type DocFormat = 'markdown' | 'plain';

type DocView =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly format: DocFormat;
      readonly editable: boolean;
      readonly note: string | null;
      readonly etag: string | null;
      readonly size: number | null;
      readonly mtimeMs: number | null;
    }
  | {
      readonly kind: 'table';
      readonly sheet: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
      readonly note: string;
    }
  | { readonly kind: 'pdf'; readonly url: string }
  | { readonly kind: 'image'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

interface RecentDoc {
  readonly name: string;
  readonly path: string;
  readonly openedAt: number;
}

const HISTORY_KEY = 'butler.focus.documents.recent.v1';
const HISTORY_MAX = 8;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function docFormatOf(name: string): DocFormat {
  const ext = extensionOf(name);
  return ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain';
}

function docTypeLabel(name: string): string {
  const ext = extensionOf(name);
  if (ext === 'md' || ext === 'markdown') return 'Markdown';
  if (ext === 'docx') return 'Word';
  if (ext === 'xlsx') return 'Excel';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'txt' || ext === 'text') return '文本';
  return '文档';
}

function readHistory(): readonly RecentDoc[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentDoc[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec['name'] === 'string' ? rec['name'] : '';
      const path = typeof rec['path'] === 'string' ? rec['path'] : '';
      const openedAt = typeof rec['openedAt'] === 'number' ? rec['openedAt'] : 0;
      if (name.length === 0 || path.length === 0 || openedAt <= 0) continue;
      out.push({ name, path, openedAt });
      if (out.length >= HISTORY_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeHistory(history: readonly RecentDoc[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 隐私模式 / 配额满：记录只是辅助，不阻断打开文件。
  }
}

function queryOf(params: Readonly<Record<string, string>>): string {
  return new URLSearchParams(params).toString();
}

interface FocusDocumentDrawerProps {
  readonly notify: Notify;
  readonly onClose: () => void;
  /** 把“有未保存修改”交给外层，点击空白 / Esc 收起时先确认。 */
  readonly onDirtyChange: (dirty: boolean) => void;
}

export function FocusDocumentDrawer({
  notify,
  onClose,
  onDirtyChange,
}: FocusDocumentDrawerProps): JSX.Element {
  const [target, setTarget] = useState<ExternalFileDto | null>(null);
  const [view, setView] = useState<DocView>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [editMode, setEditMode] = useState<'preview' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [opening, setOpening] = useState(false);
  const [history, setHistory] = useState<readonly RecentDoc[]>(() => readHistory());

  const externalRef = useRef<ExternalFileDto | null>(null);
  const loadSeqRef = useRef(0);

  const dirty = view.kind === 'text' && view.editable && draft !== view.text;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    return () => onDirtyChange(false);
  }, [onDirtyChange]);

  const closeExternal = useCallback((file: ExternalFileDto): void => {
    if (externalRef.current?.id === file.id) externalRef.current = null;
    void postJson('/api/files/close', { handle: file.id, sessionId: file.sessionId }).catch(
      () => {
        // 句柄已失效或页面正在卸载时关闭失败没有补救动作。
      },
    );
  }, []);

  // 抽屉卸载时关闭仍在打开的外部句柄。
  useEffect(() => {
    return () => {
      const openExternal = externalRef.current;
      if (openExternal !== null) {
        externalRef.current = null;
        void postJson('/api/files/close', {
          handle: openExternal.id,
          sessionId: openExternal.sessionId,
        }).catch(() => {});
      }
    };
  }, []);

  function recordOpen(file: ExternalFileDto): void {
    setHistory((prev) => {
      const next: RecentDoc[] = [
        { name: file.name, path: file.path, openedAt: Date.now() },
        ...prev.filter((item) => item.path !== file.path),
      ].slice(0, HISTORY_MAX);
      writeHistory(next);
      return next;
    });
  }

  async function chooseFile(): Promise<void> {
    setOpening(true);
    try {
      const res = await postJson<{ readonly ok: boolean; readonly file: ExternalFileDto }>(
        '/api/files/open-dialog',
        { sessionId: DOCUMENT_SCOPE },
      );
      if (externalRef.current !== null) closeExternal(externalRef.current);
      externalRef.current = res.file;
      setTarget(res.file);
      recordOpen(res.file);
      await loadFile(res.file);
    } catch (err) {
      notify(errorMessage(err), 'warning');
    } finally {
      setOpening(false);
    }
  }

  async function loadFile(file: ExternalFileDto): Promise<void> {
    const seq = ++loadSeqRef.current;
    setView({ kind: 'loading' });
    setDraft('');
    setSaveError(null);
    setConflict(false);
    try {
      const res = await fetchJson<ExternalPreviewResponse>(
        `/api/files/preview?${queryOf({ handle: file.id, sessionId: file.sessionId })}`,
      );
      if (seq !== loadSeqRef.current) return;
      if (res.kind === 'pdf') {
        setView({ kind: 'pdf', url: res.url });
        return;
      }
      if (res.kind === 'image') {
        setView({ kind: 'image', url: res.url });
        return;
      }
      if (res.kind === 'table') {
        setView({
          kind: 'table',
          sheet: res.sheet,
          rows: res.rows,
          truncated: res.truncated,
          note: res.note,
        });
        return;
      }
      if ('etag' in res) {
        const format = docFormatOf(file.name);
        setDraft(res.text);
        setEditMode(format === 'markdown' ? 'preview' : 'edit');
        setView({
          kind: 'text',
          text: res.text,
          format,
          editable: file.editable,
          note: null,
          etag: res.etag,
          size: file.size,
          mtimeMs: file.mtimeMs,
        });
        return;
      }
      if (!('note' in res)) return;
      setView({
        kind: 'text',
        text: res.text,
        format: 'plain',
        editable: false,
        note: res.note,
        etag: null,
        size: file.size,
        mtimeMs: file.mtimeMs,
      });
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setView({ kind: 'error', message: errorMessage(err) });
    }
  }

  function closeViewer(): void {
    if (dirty && !window.confirm('有未保存的修改，确定返回？')) return;
    if (target !== null) closeExternal(target);
    setTarget(null);
    setView({ kind: 'loading' });
    setDraft('');
    setSaveError(null);
    setConflict(false);
  }

  async function saveText(overwrite: boolean): Promise<void> {
    if (target === null || view.kind !== 'text' || !view.editable || saving) return;
    const content = draft;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      let etag = view.etag;
      if (overwrite) {
        const meta = await fetchJson<ExternalMetaResponse>(
          `/api/files/meta?${queryOf({ handle: target.id, sessionId: target.sessionId })}`,
        );
        etag = meta.file.etag;
      }
      if (etag === null) throw new Error('这个文件没有可保存的版本信息');
      const res = await putJson<ExternalSaveResponse>('/api/files/content', {
        handle: target.id,
        sessionId: target.sessionId,
        text: content,
        etag,
      });
      setView((prev) =>
        prev.kind === 'text' ? { ...prev, text: content, etag: res.etag, mtimeMs: res.mtimeMs } : prev,
      );
      notify('已保存', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        return;
      }
      const message = errorMessage(err);
      setSaveError(message);
      notify(message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveText(false);
    }
  }

  function clearHistory(): void {
    setHistory([]);
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      // 清不掉记录不影响阅读本身。
    }
  }

  return (
    <aside className="focus-drawer focus-doc-drawer" role="dialog" aria-modal="false" aria-label="文档">
      <header className="focus-drawer-head">
        <div>
          <p className="focus-drawer-kicker">文档</p>
          <h2>阅读</h2>
        </div>
        <div className="focus-drawer-head-actions">
          {target === null && (
            <button
              type="button"
              className="focus-text-btn"
              onClick={() => void chooseFile()}
              disabled={opening}
              title="从系统选择框打开文件"
            >
              <Icon name="file" size={14} /> {opening ? '打开中…' : '打开文件'}
            </button>
          )}
          <button
            type="button"
            className="focus-icon-btn"
            onClick={onClose}
            aria-label="收起文档"
            title="收起"
            autoFocus
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      <div className="focus-drawer-body focus-drawer-body--docs">
        {target === null ? (
          <div className="focus-doc-home">
            <div className="focus-doc-intro">
              <span className="focus-doc-intro-icon" aria-hidden="true">
                <Icon name="file" size={22} />
              </span>
              <h3>安静地读一份文件</h3>
              <p>支持 Markdown、纯文本、Word（docx）、Excel（xlsx）与 PDF。</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void chooseFile()}
                disabled={opening}
              >
                {opening ? '正在打开…' : '打开文件'}
              </button>
              <p className="focus-doc-intro-note">
                文件由系统选择框打开，不会上传；只有文本与 Markdown 可以简单编辑。
              </p>
            </div>

            <section className="focus-doc-recent" aria-label="打开记录">
              <div className="focus-doc-recent-head">
                <span>打开记录</span>
                {history.length > 0 && (
                  <button type="button" className="focus-text-btn" onClick={clearHistory}>
                    清空
                  </button>
                )}
              </div>
              {history.length === 0 ? (
                <p className="focus-doc-recent-empty">还没有打开过文件。</p>
              ) : (
                <ul className="focus-doc-recent-list">
                  {history.map((item) => (
                    <li key={item.path}>
                      <Icon name="file" size={14} />
                      <div>
                        <strong title={item.path}>{item.name}</strong>
                        <small title={item.path}>{item.path}</small>
                        <time>{formatDateTime(item.openedAt)}</time>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="focus-doc-recent-note">
                记录只保留名称、路径与时间；再次查看需要重新选择文件。
              </p>
            </section>
          </div>
        ) : (
          <div className="focus-doc">
            <div className="focus-doc-viewer-head">
              <button
                type="button"
                className="focus-icon-btn"
                onClick={closeViewer}
                aria-label="返回文档首页"
                title="返回"
              >
                <Icon name="arrowLeft" size={15} />
              </button>
              <div className="focus-doc-viewer-title">
                <strong title={target.path}>{target.name}</strong>
                <small>{docTypeLabel(target.name)}</small>
              </div>
              <span className="focus-doc-badge">外部文件</span>
            </div>

            {view.kind === 'loading' && (
              <div className="focus-doc-loading" aria-busy="true">
                <span className="review-spinner" aria-hidden="true" />
                <p>正在读取文档…</p>
              </div>
            )}

            {view.kind === 'error' && (
              <div className="focus-doc-empty" role="alert">
                <Icon name="alert" size={20} />
                <p>{view.message}</p>
                <div className="focus-doc-empty-actions">
                  <button
                    type="button"
                    className="focus-text-btn"
                    onClick={() => void loadFile(target)}
                  >
                    重试
                  </button>
                  <button type="button" className="focus-text-btn is-muted" onClick={closeViewer}>
                    返回
                  </button>
                </div>
              </div>
            )}

            {view.kind === 'text' && (
              <>
                <div className="focus-doc-toolbar">
                  <span className="focus-doc-meta">
                    {view.note === null && dirty
                      ? '未保存'
                      : view.editable
                        ? '已保存'
                        : '只读预览'}
                    {view.size !== null && ` · ${formatBytes(view.size)}`}
                  </span>
                  <div className="focus-doc-toolbar-actions">
                    {view.format === 'markdown' && view.editable && (
                      <button
                        type="button"
                        className="focus-text-btn"
                        onClick={() =>
                          setEditMode((prev) => (prev === 'preview' ? 'edit' : 'preview'))
                        }
                      >
                        {editMode === 'preview' ? '编辑' : '预览'}
                      </button>
                    )}
                    {view.editable && (
                      <button
                        type="button"
                        className="focus-text-btn is-primary"
                        disabled={!dirty || saving}
                        onClick={() => void saveText(false)}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    )}
                  </div>
                </div>
                {view.note !== null && (
                  <p className="focus-doc-note">
                    <Icon name="info" size={13} />
                    <span>{view.note}</span>
                  </p>
                )}
                {saveError !== null && (
                  <p className="focus-doc-error" role="alert">{saveError}</p>
                )}
                {conflict && (
                  <div className="focus-doc-conflict" role="alert">
                    <span>文件已被外部修改。刷新会丢弃修改，覆盖会写回磁盘。</span>
                    <div>
                      <button
                        type="button"
                        className="focus-text-btn"
                        onClick={() => void loadFile(target)}
                      >
                        重新载入
                      </button>
                      <button
                        type="button"
                        className="focus-text-btn is-danger"
                        onClick={() => void saveText(true)}
                      >
                        覆盖保存
                      </button>
                    </div>
                  </div>
                )}
                {view.note !== null ? (
                  <pre className="focus-doc-pre">{view.text}</pre>
                ) : view.format === 'markdown' && (editMode === 'preview' || !view.editable) ? (
                  <div className="focus-doc-markdown">
                    <Markdown text={draft} />
                  </div>
                ) : (
                  <textarea
                    className="focus-doc-editor"
                    value={draft}
                    readOnly={!view.editable}
                    spellCheck={false}
                    aria-label={`编辑 ${target.name}`}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleEditorKeyDown}
                  />
                )}
              </>
            )}

            {view.kind === 'table' && (
              <div className="focus-doc-table-wrap">
                <div className="focus-doc-table-head">
                  <span>工作表：{view.sheet}</span>
                  <span className="focus-doc-badge" title={view.note}>只读</span>
                </div>
                <div className="focus-doc-table-scroll">
                  {view.rows.length === 0 ? (
                    <p className="focus-doc-empty">这个工作表没有内容。</p>
                  ) : (
                    <table className="focus-doc-table">
                      <tbody>
                        {view.rows.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <td key={cellIndex}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {view.truncated && <p className="focus-doc-note">内容过大，只显示前一部分。</p>}
                <p className="focus-doc-note">
                  <Icon name="info" size={13} />
                  <span>{view.note}</span>
                </p>
              </div>
            )}

            {view.kind === 'pdf' && (
              <div className="focus-doc-pdf">
                <a className="focus-text-btn" href={view.url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={13} /> 在新标签打开
                </a>
                <iframe src={view.url} title="PDF 预览" />
              </div>
            )}

            {view.kind === 'image' && (
              <div className="focus-doc-image">
                <img src={view.url} alt={target.name} />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
