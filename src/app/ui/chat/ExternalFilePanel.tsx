'use client';

/**
 * 工作区外文件面板 —— 右栏「文件」实例的内容
 *
 * 与工作区面板的区别：这里操作的是**用户用原生选择框指定的任意文件**，
 * 前端只拿到一个 handle，所有读写都带 handle + sessionId 回服务端查表。
 *
 * 四块能力：
 *   · 预览：文本可编辑、图片、PDF、docx/xlsx 只读表格；
 *   · 保存：Ctrl/Cmd+S 或按钮；带 etag，409 时让用户明确选择刷新还是覆盖；
 *   · 实时监听：SSE 收到 changed/deleted；无脏数据时自动刷新，有脏数据时只提示；
 *   · AI 授权：默认开启，开关调 grant/revoke，徽标始终反映服务端真实状态。
 *
 * ★ 为什么所有请求都带 sessionId：句柄是按会话登记的，跨会话读别的窗口打开的文件
 *   应该失败，而不是把两个会话的文件混在一起。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import { ApiError, errorMessage, fetchJson, postJson, putJson } from '../lib/api.js';
import { formatBytes, formatDateTime } from '../lib/format.js';

/** 服务端 open-dialog / meta 返回的文件句柄信息；id 即 handle，前端不接触裸路径接口。 */
export interface ExternalFileHandleDto {
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

interface ExternalFilePanelProps {
  readonly sessionId: string;
  readonly file: ExternalFileHandleDto;
  /** 有关闭入口时由父层传入；没有也不影响面板工作（列表里也能关）。 */
  readonly onClose?: () => void;
}

/** 请求成功后展示的内容；文本/表格/图片/PDF 的字段互斥，用 kind 区分。 */
type PreviewView =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly note: string | null;
      readonly editable: boolean;
    }
  | { readonly kind: 'image'; readonly url: string }
  | { readonly kind: 'pdf'; readonly url: string }
  | {
      readonly kind: 'table';
      readonly sheet: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
      readonly note: string;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `/api/files/preview` 的返回。
 * ★ 两个 kind:'text' 分支不是重复：一个是可编辑文本（带 etag），
 *   另一个是 Office 解析出来的只读文本（带 note、没有 etag，不能保存）。
 */
type PreviewResponse =
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

type WatchEvent =
  | { readonly type: 'ready' }
  | {
      readonly type: 'changed';
      readonly mtimeMs?: number;
      readonly size?: number;
      readonly etag?: string;
    }
  | { readonly type: 'deleted' }
  | { readonly type: 'error'; readonly message?: string };

interface SaveResponse {
  readonly ok: boolean;
  readonly etag: string;
  readonly mtimeMs: number;
}

interface MetaResponse {
  readonly ok: boolean;
  readonly file: ExternalFileHandleDto;
}

/** AI 授权状态：granting/revoking 是请求在途，徽标用“正在…”而不是假装已成功。 */
type AiState = 'granting' | 'granted' | 'revoking' | 'revoked';

const AI_LABEL: Record<AiState, string> = {
  granting: '正在授权…',
  granted: 'AI 可读写',
  revoking: '正在撤销…',
  revoked: 'AI 不可访问',
};

const KIND_LABEL: Record<ExternalFileHandleDto['kind'], string> = {
  text: '文本',
  image: '图片',
  pdf: 'PDF',
  office: 'Office 只读',
  unsupported: '未知类型',
};

/** 变更事件是 JSON 放在 SSE 的 data 里（不是 event: 名），解析失败就忽略这一条。 */
function parseWatchEvent(raw: string): WatchEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as Record<string, unknown>)['type'];
  if (type !== 'ready' && type !== 'changed' && type !== 'deleted' && type !== 'error') {
    return null;
  }
  return parsed as WatchEvent;
}

function previewQuery(fileId: string, sessionId: string): string {
  return new URLSearchParams({ handle: fileId, sessionId }).toString();
}

export function ExternalFilePanel({
  sessionId,
  file,
  onClose,
}: ExternalFilePanelProps): JSX.Element {
  const [view, setView] = useState<PreviewView>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [meta, setMeta] = useState({
    size: file.size,
    mtimeMs: file.mtimeMs,
    etag: file.etag,
  });
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [aiState, setAiState] = useState<AiState>('granting');
  const [aiError, setAiError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [imageBroken, setImageBroken] = useState(false);
  /** 图片/PDF 的 cache-buster：同一个 URL 重新加载浏览器不会重取字节。 */
  const [mediaNonce, setMediaNonce] = useState(0);

  /** 预览请求序号：自动刷新与手动刷新可能交叉，只认最后一次响应。 */
  const seqRef = useRef(0);
  const draftRef = useRef('');
  const metaRef = useRef(meta);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const aiBusy = aiState === 'granting' || aiState === 'revoking';

  const dirty = view.kind === 'text' && view.editable && draft !== view.text;
  draftRef.current = draft;
  metaRef.current = meta;
  dirtyRef.current = dirty;
  savingRef.current = saving;

  const loadPreview = useCallback(
    async (force: boolean): Promise<void> => {
      const seq = ++seqRef.current;
      if (force) setView({ kind: 'loading' });
      try {
        const res = await fetchJson<PreviewResponse>(
          `/api/files/preview?${previewQuery(file.id, sessionId)}`,
        );
        if (seq !== seqRef.current) return;
        /**
         * ★ 自动刷新在请求发出后才可能变成“用户已经改过”：
         *   这时不能把新内容盖上去，否则用户刚打的字会无声消失。
         *   手动“重新载入”走 force=true，是用户明确同意丢弃本地修改。
         */
        if (!force && dirtyRef.current) {
          setDiskChanged(true);
          return;
        }
        setDeleted(false);
        setDiskChanged(false);
        setConflict(false);
        setErrorText(null);
        setImageBroken(false);
        if (res.kind === 'text') {
          if ('etag' in res) {
            setMeta((prev) => ({ ...prev, etag: res.etag }));
            setDraft(res.text);
            setView({ kind: 'text', text: res.text, note: null, editable: file.editable });
          } else {
            // Office 解出来的纯文本：没有 etag，也没有保存入口。
            setView({ kind: 'text', text: res.text, note: res.note, editable: false });
          }
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
        // 剩下的只有图片 / PDF：字节走 /api/files/raw，前端只拿 URL。
        setView({ kind: res.kind, url: res.url });
        setMediaNonce((prev) => prev + 1);
      } catch (err) {
        if (seq !== seqRef.current) return;
        const message = errorMessage(err);
        if (err instanceof ApiError && err.status === 404) {
          // 句柄失效或文件被删：保留已有内容，只把保存禁掉，让用户还能复制。
          setDeleted(true);
          setDiskChanged(false);
          if (force) setView({ kind: 'error', message });
          return;
        }
        if (force) setView({ kind: 'error', message });
        else setErrorText(message);
      }
    },
    [file.editable, file.id, sessionId],
  );

  // 首次挂载拉一次预览；StrictMode 会跑两次，序号会丢弃前一次。
  useEffect(() => {
    void loadPreview(true);
  }, [loadPreview]);

  /**
   * 实时监听。
   * ★ 用 ref 读“此刻是否有脏数据”，才不会因为用户每敲一个字就重连 SSE。
   * ★ 自己保存也会触发 changed；保存途中忽略，避免把本地写入误报成“磁盘变了”。
   */
  useEffect(() => {
    const source = new EventSource(
      `/api/files/watch?${previewQuery(file.id, sessionId)}`,
    );
    source.onmessage = (event: MessageEvent<string>) => {
      const parsed = parseWatchEvent(event.data);
      if (parsed === null) return;
      if (parsed.type === 'ready') {
        setWatchError(null);
        return;
      }
      if (parsed.type === 'changed') {
        setWatchError(null);
        if (savingRef.current) return;
        setDeleted(false);
        if (dirtyRef.current) {
          setDiskChanged(true);
          return;
        }
        setMeta((prev) => ({
          size: parsed.size ?? prev.size,
          mtimeMs: parsed.mtimeMs ?? prev.mtimeMs,
          etag: parsed.etag ?? prev.etag,
        }));
        void loadPreview(false);
        return;
      }
      if (parsed.type === 'deleted') {
        setDeleted(true);
        setDiskChanged(false);
        return;
      }
      setWatchError(parsed.message ?? '文件监听失败');
    };
    source.onerror = () => {
      // EventSource 自己会重连：这里只报“暂时断开”，不要把面板打成错误态。
      setWatchError('实时监听已断开，正在重连…');
    };
    return () => {
      source.close();
    };
  }, [file.id, loadPreview, sessionId]);

  /**
   * 卸载时关闭服务端句柄。
   * ★ 延迟到下一轮事件循环：React StrictMode 会“挂载→卸载→再挂载”，
   *   同步调用 close 会让第二次挂载拿到一个已经销毁的句柄。
   *   真正的实例关闭（列表 ×、切会话、离开对话空间）不会再挂载，定时器照常执行。
   */
  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    return () => {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        void postJson('/api/files/close', { handle: file.id, sessionId }).catch(() => {
          // 页面正在卸载/句柄已失效时关闭失败没有补救动作，也不能阻塞卸载。
        });
      }, 0);
    };
  }, [file.id, sessionId]);

  /**
   * 默认开启 AI 读写：打开面板就 grant。
   * ★ 失败必须回退成“不可访问”并显示原因：徽标不能停在用户以为授权成功的位置。
   */
  useEffect(() => {
    let cancelled = false;
    setAiState('granting');
    setAiError(null);
    postJson('/api/files/grant', { handle: file.id, sessionId })
      .then(() => {
        if (!cancelled) setAiState('granted');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAiState('revoked');
        setAiError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file.id, sessionId]);

  async function toggleAi(next: boolean): Promise<void> {
    if (aiBusy) return;
    const previous = aiState;
    setAiError(null);
    setAiState(next ? 'granting' : 'revoking');
    try {
      await postJson(next ? '/api/files/grant' : '/api/files/revoke', {
        handle: file.id,
        sessionId,
      });
      setAiState(next ? 'granted' : 'revoked');
    } catch (err) {
      // 回退到操作前的状态：失败不能留下一个“看起来已关闭/已开启”的开关。
      setAiState(previous);
      setAiError(errorMessage(err));
    }
  }

  async function save(etagOverride?: string): Promise<void> {
    if (view.kind !== 'text' || !view.editable || deleted || savingRef.current) return;
    // 先快照：请求期间用户还能继续打字，成功后只能把“这次发出去的文本”当作基线。
    const text = draftRef.current;
    // 同步置位：Ctrl+S 连按时第二次会在重渲染前进入，只看 state 会发出两个 PUT。
    savingRef.current = true;
    setSaving(true);
    setErrorText(null);
    setConflict(false);
    try {
      const res = await putJson<SaveResponse>('/api/files/content', {
        handle: file.id,
        sessionId,
        text,
        etag: etagOverride ?? metaRef.current.etag,
      });
      setMeta((prev) => ({ ...prev, etag: res.etag, mtimeMs: res.mtimeMs }));
      setView((prev) => (prev.kind === 'text' ? { ...prev, text } : prev));
      setDiskChanged(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // ★ 不自动覆盖：先让用户看到“文件被外部改了”，再由他选刷新还是覆盖。
        setConflict(true);
        return;
      }
      setErrorText(errorMessage(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  /** 覆盖保存：先读最新 etag，再用本地内容覆盖；期间又变会再次 409，仍由用户决定。 */
  async function overwrite(): Promise<void> {
    if (savingRef.current) return;
    setErrorText(null);
    try {
      const res = await fetchJson<MetaResponse>(
        `/api/files/meta?${previewQuery(file.id, sessionId)}`,
      );
      await save(res.file.etag);
    } catch (err) {
      setErrorText(errorMessage(err));
    }
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }

  function renderBody(): JSX.Element {
    if (view.kind === 'loading') {
      return (
        <div className="external-file-placeholder" aria-busy="true">
          <span className="review-spinner" aria-hidden="true" />
          <h3>正在读取文件</h3>
          <p>{file.path}</p>
        </div>
      );
    }
    if (view.kind === 'error') {
      return (
        <div className="external-file-placeholder is-error" role="alert">
          <Icon name="alert" size={24} />
          <h3>无法预览这个文件</h3>
          <p>{view.message}</p>
          <p className="external-file-placeholder-path">{file.path}</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void loadPreview(true)}
          >
            重试
          </button>
        </div>
      );
    }
    if (view.kind === 'image') {
      return (
        <div className="external-file-image">
          {imageBroken ? (
            <p className="external-file-placeholder-path" role="alert">
              图片无法显示，可能已经被删除或不是有效的图片文件。
            </p>
          ) : (
            <img
              key={`${view.url}:${mediaNonce}`}
              src={view.url}
              alt={file.name}
              onError={() => setImageBroken(true)}
            />
          )}
        </div>
      );
    }
    if (view.kind === 'pdf') {
      return (
        <>
          <div className="external-file-pdf-bar">
            {/* 没有 PDF 插件的环境里 iframe 会空白，永远留一条可用的外链。 */}
            <a className="text-btn" href={view.url} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} /> 在新标签打开
            </a>
          </div>
          <iframe
            key={`${view.url}:${mediaNonce}`}
            className="external-file-pdf"
            src={view.url}
            title={`PDF 预览：${file.name}`}
          />
        </>
      );
    }
    if (view.kind === 'table') {
      return (
        <div className="external-file-table-wrap">
          <div className="external-file-table-caption">
            <span>工作表：{view.sheet}</span>
            <span className="external-file-table-readonly" title={view.note}>
              只读
            </span>
          </div>
          <div className="external-file-table-scroll">
            {view.rows.length === 0 ? (
              <p className="external-file-table-empty">这个工作表没有内容。</p>
            ) : (
              <table className="external-file-table">
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
          {view.truncated ? <div className="external-file-table-foot">内容过大，已截断</div> : null}
        </div>
      );
    }
    // text
    return (
      <>
        {view.note !== null ? (
          <p className="external-file-note">
            <Icon name="info" size={13} />
            <span>{view.note}</span>
          </p>
        ) : null}
        {view.note === null ? (
          <textarea
            className="external-file-textarea"
            value={draft}
            readOnly={!view.editable || deleted}
            spellCheck={false}
            aria-label={`编辑 ${file.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleEditorKeyDown}
          />
        ) : (
          <pre className="external-file-text">{view.text}</pre>
        )}
      </>
    );
  }

  return (
    <section className="external-file-panel" aria-label={`外部文件 ${file.name}`}>
      <header className="external-file-head">
        <div className="external-file-title">
          <span className="external-file-name" title={file.path}>
            {file.name}
          </span>
          <span className="external-file-path" title={file.path}>
            {file.path}
          </span>
        </div>
        <div className="external-file-meta">
          <span>{KIND_LABEL[file.kind]}</span>
          <span>{formatBytes(meta.size)}</span>
          <span title="文件最后修改时间">{formatDateTime(meta.mtimeMs)}</span>
          <span className="external-file-etag" title={`etag ${meta.etag}`}>
            etag {meta.etag.slice(0, 8)}
          </span>
        </div>
        <div className="external-file-ai">
          <span className={`external-file-ai-badge is-${aiState}`}>{AI_LABEL[aiState]}</span>
          <span className="external-file-ai-label">允许 AI 读写</span>
          <Switch
            checked={aiState === 'granted'}
            onChange={(next) => void toggleAi(next)}
            label="允许 AI 读写这个文件"
            disabled={aiBusy}
          />
        </div>
        {onClose !== undefined ? (
          <button
            type="button"
            className="external-file-close"
            aria-label="关闭文件面板"
            title="关闭文件面板"
            onClick={onClose}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </header>

      {deleted ? (
        <div className="external-file-banner is-danger" role="alert">
          <Icon name="alert" size={13} />
          <span className="external-file-banner-text">文件已被删除或移动，保存已禁用。</span>
        </div>
      ) : null}
      {conflict ? (
        <div className="external-file-banner is-warn" role="alert">
          <Icon name="alert" size={13} />
          <span className="external-file-banner-text">
            文件已被外部修改。刷新会丢弃本地修改，覆盖会把本地内容写回磁盘。
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={saving}
            onClick={() => void loadPreview(true)}
          >
            重新载入
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={saving}
            onClick={() => void overwrite()}
          >
            覆盖保存
          </button>
        </div>
      ) : null}
      {diskChanged ? (
        <div className="external-file-banner is-warn" role="status">
          <Icon name="info" size={13} />
          <span className="external-file-banner-text">
            磁盘内容已变化，面板里还有未保存的修改。
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={saving}
            onClick={() => void loadPreview(true)}
          >
            刷新
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDiskChanged(false)}
          >
            继续编辑
          </button>
        </div>
      ) : null}
      {errorText !== null ? (
        <div className="external-file-banner is-danger" role="alert">
          <Icon name="alert" size={13} />
          <span className="external-file-banner-text">{errorText}</span>
          <button
            type="button"
            className="external-file-banner-close"
            aria-label="关闭错误提示"
            onClick={() => setErrorText(null)}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ) : null}
      {aiError !== null ? (
        <div className="external-file-banner is-danger" role="alert">
          <Icon name="alert" size={13} />
          <span className="external-file-banner-text">AI 授权失败：{aiError}</span>
        </div>
      ) : null}
      {watchError !== null ? (
        <div className="external-file-banner is-info" role="status">
          <Icon name="info" size={13} />
          <span className="external-file-banner-text">{watchError}</span>
        </div>
      ) : null}

      {view.kind === 'text' && view.editable ? (
        <div className="external-file-toolbar">
          <span className={`external-file-state${dirty ? ' is-dirty' : ''}`}>
            {dirty ? '未保存' : '已保存'}
          </span>
          <span className="external-file-size">{formatBytes(meta.size)}</span>
          <span className="external-file-etag" title={`etag ${meta.etag}`}>
            etag {meta.etag.slice(0, 8)}
          </span>
          {deleted ? <span className="external-file-readonly">文件已删除</span> : null}
          <span className="external-file-shortcut">Ctrl/Cmd+S 保存</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!dirty || saving || deleted}
            title={deleted ? '文件已删除，无法保存' : '保存到磁盘'}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      ) : null}

      {renderBody()}
    </section>
  );
}
