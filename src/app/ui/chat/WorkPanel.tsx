'use client';

/**
 * 工作区面板 —— 右栏「文件」页签的内容
 *
 * 三块能力：
 *   · 左侧文件树：从工作区根目录开始懒加载，目录排在文件前面；
 *   · 右侧内容区：文本可编辑保存（带冲突检测）、图片直接预览、其它文件给出说明；
 *   · AI 联动：收到 aiOp 时自动打开被读写的文件并高亮；本文件有未保存修改时
 *     只提示、不覆盖编辑器内容。
 *
 * ★ 为什么不用通用编辑器库：
 *   P0 只需要「看 + 改 + 存」，textarea 足够；引入 Monaco/CodeMirror 会带来
 *   几 MB 体积与一整套与现有浅色控制台不一致的视觉，收益和成本不成比例。
 *
 * ★ 所有请求都带 sessionId：面板与 AI 工具必须作用在同一个会话工作区，
 *   否则用户手改的文件和 AI 改的文件可能不是同一个。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, UIEvent as ReactUIEvent } from 'react';

import { Icon } from '../components/Icon';
import { ApiError, errorMessage, fetchJson, putJson } from '../lib/api.js';
import { formatBytes, formatDateTime } from '../lib/format.js';

/** 交给工作区面板的 AI 操作（来自一次完整的工具调用）。 */
export interface WorkPanelAiOp {
  readonly path: string;
  readonly writing: boolean;
}

interface WorkPanelProps {
  readonly sessionId: string | null;
  readonly open: boolean;
  readonly aiOp: WorkPanelAiOp | null;
}

interface WorkspaceEntryDto {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

interface WorkspaceListResponse {
  readonly ok: boolean;
  readonly root: string;
  readonly path: string;
  readonly entries: readonly WorkspaceEntryDto[];
}

interface WorkspaceFileResponse {
  readonly ok: boolean;
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

interface WorkspaceSaveResponse {
  readonly ok: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * `/api/workspace/preview` 的三种返回。
 *
 * ★ 为什么 PDF 只拿 URL：浏览器自带 PDF 查看器比任何前端库都稳定，
 *   服务端也只做权限校验后把原始字节交给 raw 端点，前端不必再解析。
 */
type WorkspacePreviewResponse =
  | { readonly ok: boolean; readonly kind: 'pdf'; readonly url: string }
  | {
      readonly ok: boolean;
      readonly kind: 'text';
      readonly text: string;
      readonly note: string;
    }
  | {
      readonly ok: boolean;
      readonly kind: 'table';
      readonly sheet: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
      readonly note: string;
    };

/** 一个目录的加载状态。树是按目录懒加载的，所以状态也按目录存。 */
type DirState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly WorkspaceEntryDto[] }
  | { readonly status: 'error'; readonly message: string };

/** 右侧当前展示的内容。 */
type FileView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading'; readonly path: string }
  | {
      readonly kind: 'text';
      readonly path: string;
      readonly content: string;
      readonly sha256: string;
      readonly size: number;
      readonly mtimeMs: number;
    }
  | {
      readonly kind: 'image';
      readonly path: string;
      readonly size: number | null;
      readonly mtimeMs: number | null;
    }
  | { readonly kind: 'preview-loading'; readonly path: string }
  | {
      readonly kind: 'preview';
      readonly path: string;
      readonly preview: WorkspacePreviewResponse;
      readonly size: number | null;
      readonly mtimeMs: number | null;
    }
  | {
      readonly kind: 'preview-error';
      readonly path: string;
      readonly message: string;
      readonly size: number | null;
      readonly mtimeMs: number | null;
    }
  | {
      readonly kind: 'unsupported';
      readonly path: string;
      readonly size: number | null;
      readonly mtimeMs: number | null;
      readonly message: string;
    }
  | { readonly kind: 'error'; readonly path: string; readonly message: string };

interface SaveFailure {
  /** true 表示 409：文件被外部改过，需要用户明确选择「重新载入」。 */
  readonly conflict: boolean;
  readonly message: string;
}

interface AiNotice {
  readonly path: string;
  readonly writing: boolean;
}

/** 图片扩展名与后端 raw 端点的放行表保持一致；这里只决定「用 img 还是用编辑器」。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** 能走 `/api/workspace/preview` 的扩展名；与后端 preview 路由的支持范围一致。 */
const PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'docx', 'xlsx']);

/** 旧版 Office 二进制格式：后端明确不支持，界面直接给提示，不必先打一次 400。 */
const LEGACY_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['doc', 'xls']);

function isPreviewPath(path: string): boolean {
  return PREVIEW_EXTENSIONS.has(extensionOf(path));
}

function isLegacyOfficePath(path: string): boolean {
  return LEGACY_OFFICE_EXTENSIONS.has(extensionOf(path));
}

/**
 * 目录路径不会走到文件读取接口：`list_dir`/`grep` 也会带路径，
 * 把 `.` 或 `docs` 当文件打开只会得到 400。
 */
function isDirectoryLike(path: string): boolean {
  return path.length === 0 || path === '.' || path.endsWith('/');
}

/** glob/grep 的 path 可能是 `src/**\/*.ts` 这种模式，不是某个具体文件。 */
function isPatternLike(path: string): boolean {
  return path.includes('*') || path.includes('?') || path.includes('[');
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '.' : path.slice(0, index);
}

function sortEntries(entries: readonly WorkspaceEntryDto[]): WorkspaceEntryDto[] {
  // 后端已排序；这里再排一次，保证「目录在前」不依赖服务端版本。
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : null;
}

export function WorkPanel({ sessionId, open, aiOp }: WorkPanelProps): JSX.Element {
  // ── 文件树 ─────────────────────────────────────────────────────────
  const [dirs, setDirs] = useState<Readonly<Record<string, DirState>>>({});
  const dirsRef = useRef<Record<string, DirState>>({});
  const loadingDirsRef = useRef<Set<string>>(new Set());
  /** 切会话时自增；旧会话的目录响应回来时据此丢弃，避免串到新会话。 */
  const loadGenerationRef = useRef(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>(['.']));

  // ── 右侧内容 ───────────────────────────────────────────────────────
  const [view, setView] = useState<FileView>({ kind: 'empty' });
  const [draft, setDraft] = useState('');
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveFailure | null>(null);
  const [imageNonce, setImageNonce] = useState(0);
  const [imageError, setImageError] = useState(false);
  /** PDF 的 iframe 用 key 强制重建：重新打开同一个 PDF 时浏览器会复用旧文档。 */
  const [previewNonce, setPreviewNonce] = useState(0);
  /** 文件读取请求的序号：快速连点文件时只认最后一次响应。 */
  const fileSeqRef = useRef(0);

  // ── AI 联动 ────────────────────────────────────────────────────────
  const [aiNotice, setAiNotice] = useState<AiNotice | null>(null);
  const [aiBannerVisible, setAiBannerVisible] = useState(false);
  /** 有未保存修改时，AI 又动了这个文件：保留本地内容，等用户决定是否载入。 */
  const [aiConflict, setAiConflict] = useState<AiNotice | null>(null);

  const gutterRef = useRef<HTMLPreElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = view.kind === 'text' && draft !== view.content;
  // effect 里要读「此刻是否脏」但不想因为每个按键重新跑 AI 联动，所以放 ref。
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const draftRef = useRef('');
  draftRef.current = draft;

  const selectedPath = view.kind === 'empty' ? null : view.path;
  const aiPath = aiBannerVisible && aiNotice !== null ? aiNotice.path : null;

  const crumbs = useMemo(
    () => (selectedPath === null ? [] : selectedPath.split('/').filter((part) => part.length > 0)),
    [selectedPath],
  );

  const lineNumbersText = useMemo(() => {
    if (!showLineNumbers) return '';
    const count = draft.length === 0 ? 1 : draft.split('\n').length;
    let text = '';
    for (let line = 1; line <= count; line += 1) text += `${line}\n`;
    return text;
  }, [draft, showLineNumbers]);

  useEffect(() => {
    dirsRef.current = dirs;
  }, [dirs]);

  function queryOf(path: string, extra?: Readonly<Record<string, string>>): string {
    const params = new URLSearchParams();
    if (sessionId !== null && sessionId.length > 0) params.set('sessionId', sessionId);
    params.set('path', path);
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) params.set(key, value);
    }
    return params.toString();
  }

  function listUrl(path: string): string {
    return `/api/workspace?${queryOf(path)}`;
  }

  function fileUrl(path: string): string {
    return `/api/workspace/file?${queryOf(path)}`;
  }

  function rawUrl(path: string, nonce: number): string {
    return `/api/workspace/raw?${queryOf(path, { v: String(nonce) })}`;
  }

  function previewUrl(path: string): string {
    return `/api/workspace/preview?${queryOf(path)}`;
  }

  function findEntry(path: string): WorkspaceEntryDto | null {
    for (const state of Object.values(dirsRef.current)) {
      if (state.status !== 'ready') continue;
      for (const entry of state.entries) {
        if (entry.path === path) return entry;
      }
    }
    return null;
  }

  /** 已知目录（来自已加载的父目录列表）：AI 的 list_dir/grep 不该被当成文件打开。 */
  function isKnownDirectory(path: string): boolean {
    for (const state of Object.values(dirsRef.current)) {
      if (state.status !== 'ready') continue;
      for (const entry of state.entries) {
        if (entry.path === path) return entry.isDirectory;
      }
    }
    return false;
  }

  /**
   * 加载一个目录。
   *
   * `force` 用于 AI 刚刚写过文件之后：目录可能已经有了新的子项，
   * 但普通加载会因为「已经 ready」直接返回，新文件就永远不出现在树里。
   * force 时不把已有 entry 换成 loading，避免整棵树在刷新时闪一下。
   */
  async function loadDir(path: string, force = false): Promise<void> {
    const inFlight = loadingDirsRef.current;
    if (inFlight.has(path)) return;
    const existing = dirsRef.current[path];
    if (!force && existing !== undefined && existing.status === 'ready') return;

    const generation = loadGenerationRef.current;
    inFlight.add(path);
    if (!force) setDirs((prev) => ({ ...prev, [path]: { status: 'loading' } }));
    try {
      const res = await fetchJson<WorkspaceListResponse>(listUrl(path));
      if (generation !== loadGenerationRef.current) return;
      setDirs((prev) => ({
        ...prev,
        [path]: { status: 'ready', entries: sortEntries(res.entries) },
      }));
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      // 后台刷新失败就保留旧目录；只有首次加载失败才把错误放到树里。
      if (force && existing !== undefined && existing.status === 'ready') return;
      setDirs((prev) => ({
        ...prev,
        [path]: { status: 'error', message: errorMessage(err) },
      }));
    } finally {
      inFlight.delete(path);
    }
  }

  /** 展开从根目录到 dir 的所有层级，并保证它们都开始加载。 */
  function expandPath(dir: string, refresh = false): void {
    const segments = dir === '.' ? [] : dir.split('/').filter((segment) => segment.length > 0);
    const all: string[] = ['.'];
    let acc = '';
    for (const segment of segments) {
      acc = acc.length === 0 ? segment : `${acc}/${segment}`;
      all.push(acc);
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const item of all) next.add(item);
      return next;
    });
    for (const item of all) void loadDir(item, refresh && item === dir);
  }

  function revealFile(path: string, refresh = false): void {
    expandPath(parentOf(path), refresh);
  }

  function toggleDir(path: string): void {
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    void loadDir(path);
  }

  function refreshTree(): void {
    loadGenerationRef.current += 1;
    loadingDirsRef.current = new Set<string>();
    dirsRef.current = {};
    setDirs({});
    setExpanded(new Set<string>(['.']));
    void loadDir('.');
  }

  /**
   * 打开一个路径。
   *
   * `mode === 'ai'` 时不要在请求失败后把当前内容换成错误页：AI 的路径可能是
   * 目录，或者只是 grep 的一个范围；那不该破坏用户正在看的文件。
   */
  async function openPath(path: string, mode: 'user' | 'ai'): Promise<void> {
    if (isDirectoryLike(path)) return;

    const seq = fileSeqRef.current + 1;
    fileSeqRef.current = seq;
    const draftAtRequest = draftRef.current;
    setSaveError(null);
    setImageError(false);

    if (isImagePath(path)) {
      const entry = findEntry(path);
      // 每次打开都换一个 URL 参数：同一个 <img> 的 src 不变时浏览器可能复用旧图，
      // 即使服务端已经 no-store（例如 AI 刚覆盖过这张图）。
      setImageNonce((nonce) => nonce + 1);
      setView({
        kind: 'image',
        path,
        size: entry?.size ?? null,
        mtimeMs: entry?.mtimeMs ?? null,
      });
      setDraft('');
      setAiConflict(null);
      revealFile(path);
      return;
    }

    /**
     * 旧版 .doc / .xls 是 OLE 复合文档，服务端零依赖解析器不支持；
     * 本地直接给提示，避免用户点开只看到一次 400。
     */
    if (isLegacyOfficePath(path)) {
      const entry = findEntry(path);
      setView({
        kind: 'unsupported',
        path,
        size: entry?.size ?? null,
        mtimeMs: entry?.mtimeMs ?? null,
        message: '旧版 .doc / .xls 文档不支持完整预览，请用系统应用打开',
      });
      setDraft('');
      setAiConflict(null);
      revealFile(path);
      return;
    }

    /**
     * PDF / docx / xlsx 走只读预览接口。
     *
     * ★ 为什么和文本分开：这些文件返回的不是可编辑正文（PDF 只是 raw 地址），
     *   不能复用 textarea/保存逻辑；只读视图也顺手杜绝误保存。
     */
    if (isPreviewPath(path)) {
      const entry = findEntry(path);
      // PDF 的 <iframe> src 不变时浏览器会复用已加载文档，换 key 才能重新拉。
      setPreviewNonce((nonce) => nonce + 1);
      if (mode === 'user') setView({ kind: 'preview-loading', path });
      try {
        const res = await fetchJson<WorkspacePreviewResponse>(previewUrl(path));
        if (seq !== fileSeqRef.current) return;
        if (mode === 'ai' && (dirtyRef.current || draftRef.current !== draftAtRequest)) {
          setAiConflict({ path, writing: aiOp?.writing ?? false });
          return;
        }
        setView({
          kind: 'preview',
          path,
          preview: res,
          size: entry?.size ?? null,
          mtimeMs: entry?.mtimeMs ?? null,
        });
        setDraft('');
        setAiConflict(null);
        revealFile(path);
      } catch (err) {
        if (seq !== fileSeqRef.current) return;
        // AI 预览失败不覆盖用户正在看的文件，与文本分支保持一致。
        if (mode === 'ai') return;
        setView({
          kind: 'preview-error',
          path,
          message: errorMessage(err),
          size: entry?.size ?? null,
          mtimeMs: entry?.mtimeMs ?? null,
        });
        setDraft('');
      }
      return;
    }

    if (mode === 'user') setView({ kind: 'loading', path });
    try {
      const res = await fetchJson<WorkspaceFileResponse>(fileUrl(path));
      if (seq !== fileSeqRef.current) return;
      /**
       * AI 拉取期间用户可能已经开始改当前文件：这时不能拿服务端内容覆盖草稿。
       * 只标一个「AI 已更新」提示，把是否载入交给用户。
       */
      if (mode === 'ai' && (dirtyRef.current || draftRef.current !== draftAtRequest)) {
        setAiConflict({ path, writing: aiOp?.writing ?? false });
        return;
      }
      setView({
        kind: 'text',
        path: res.path,
        content: res.content,
        sha256: res.sha256,
        size: res.size,
        mtimeMs: res.mtimeMs,
      });
      setDraft(res.content);
      setAiConflict(null);
      revealFile(res.path);
    } catch (err) {
      if (seq !== fileSeqRef.current) return;
      if (mode === 'ai') return;

      const code = apiErrorCode(err);
      if (code === 'not_text' || code === 'too_large') {
        const entry = findEntry(path);
        setView({
          kind: 'unsupported',
          path,
          size: entry?.size ?? null,
          mtimeMs: entry?.mtimeMs ?? null,
          message: code === 'too_large' ? errorMessage(err) : '这种文件暂不支持预览',
        });
        setDraft('');
        return;
      }
      setView({ kind: 'error', path, message: errorMessage(err) });
    }
  }

  async function save(): Promise<void> {
    if (view.kind !== 'text' || saving || draft === view.content) return;
    const path = view.path;
    const content = draft;
    const baseSha = view.sha256;
    const seq = fileSeqRef.current;

    setSaving(true);
    setSaveError(null);
    try {
      const res = await putJson<WorkspaceSaveResponse>('/api/workspace/file', {
        sessionId,
        path,
        content,
        baseSha,
      });
      if (seq !== fileSeqRef.current) return;
      // 只更新「服务器上现在是什么」；draft 保留用户保存期间继续敲的字，
      // 于是 dirty 会继续为 true，不会假装已经保存了更新的内容。
      setView((prev) =>
        prev.kind === 'text' && prev.path === path
          ? { ...prev, content, sha256: res.sha256, size: res.size, mtimeMs: res.mtimeMs }
          : prev,
      );
      setAiConflict((prev) => (prev !== null && prev.path === path ? null : prev));
      // 树里显示的 size 也要跟着变；否则右侧 34 B、左侧还停在旧大小。
      revealFile(path, true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSaveError({ conflict: true, message: err.message });
      } else {
        // 413/400 的 message 已经是服务端原文，直接展示，不改写。
        setSaveError({ conflict: false, message: errorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadCurrent(): Promise<void> {
    if (view.kind !== 'text') return;
    if (dirtyRef.current && !window.confirm('放弃未保存的修改并重新载入？')) return;
    setSaveError(null);
    await openPath(view.path, 'user');
  }

  function loadAiVersion(): void {
    const notice = aiNotice;
    if (notice === null) return;
    if (dirtyRef.current && !window.confirm('当前文件有未保存的修改，载入 AI 版本会丢弃它们。继续？')) {
      return;
    }
    setAiBannerVisible(false);
    setAiConflict(null);
    void openPath(notice.path, 'user');
  }

  /** 用户主动切换文件：同样不能悄悄丢掉未保存的修改。 */
  function openFromTree(path: string): void {
    if (dirtyRef.current && !window.confirm('当前文件有未保存的修改，切换文件会丢弃它们。继续？')) {
      return;
    }
    void openPath(path, 'user');
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }

  function handleEditorScroll(event: ReactUIEvent<HTMLTextAreaElement>): void {
    // 行号列本身不接收滚动；跟随 textarea 的滚动位置即可对齐。
    if (gutterRef.current !== null) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
  }

  /**
   * 会话切换时整体重来：目录树、编辑器、AI 提示都属于「这个会话的工作区」。
   * 这里不用 useCallback 把 loadDir 包进来——它依赖 sessionId，直接依赖更清楚。
   */
  useEffect(() => {
    if (!open) return;
    loadGenerationRef.current += 1;
    fileSeqRef.current += 1;
    loadingDirsRef.current = new Set<string>();
    dirsRef.current = {};
    setDirs({});
    setExpanded(new Set<string>(['.']));
    setView({ kind: 'empty' });
    setDraft('');
    setSaveError(null);
    setImageError(false);
    setAiNotice(null);
    setAiBannerVisible(false);
    setAiConflict(null);
    void loadDir('.');
    // 只以「会话 / 面板开关」为重置条件；loadDir 是当前渲染里的实现，不需要进依赖。
  }, [open, sessionId]);

  /**
   * AI 操作到达：
   *   · 先记横幅，8 秒后自动消失（下一次 aiOp 会覆盖它）；
   *   · 本文件脏时不拉新内容，只留冲突提示，等用户点「载入 AI 版本」；
   *   · 否则静默重新拉取/打开，失败也不覆盖当前视图（见 openPath 的 ai 分支）。
   */
  useEffect(() => {
    if (!open) return;
    if (aiOp === null) {
      // 上层会在 8 秒后清掉 aiOp；这里同步收起横幅，
      // 否则那个 effect 的 cleanup 会把本组件的计时器一起取消，横幅就再也不消失。
      setAiBannerVisible(false);
      return;
    }
    if (isDirectoryLike(aiOp.path) || isPatternLike(aiOp.path) || isKnownDirectory(aiOp.path)) {
      return;
    }

    setAiNotice({ path: aiOp.path, writing: aiOp.writing });
    setAiBannerVisible(true);
    const timer = window.setTimeout(() => setAiBannerVisible(false), 8000);

    if (dirtyRef.current) {
      setAiConflict({ path: aiOp.path, writing: aiOp.writing });
      return () => window.clearTimeout(timer);
    }

    void openPath(aiOp.path, 'ai');
    // 写文件可能在工作区里新建一个条目：强制刷新父目录，树里才看得到它。
    revealFile(aiOp.path, aiOp.writing);
    return () => window.clearTimeout(timer);
  }, [aiOp, open]);

  function renderDirectory(path: string, depth: number): JSX.Element {
    const state = dirs[path];
    const indent = { paddingLeft: `${8 + depth * 14}px` };

    if (state === undefined || state.status === 'loading') {
      return (
        <div className="work-tree-status" style={indent} aria-busy="true">
          加载中…
        </div>
      );
    }
    if (state.status === 'error') {
      return (
        <div className="work-tree-status is-error" style={indent}>
          <span>{state.message}</span>
          <button type="button" className="work-link" onClick={() => void loadDir(path)}>
            重试
          </button>
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div className="work-tree-status is-empty" style={indent}>
          空目录
        </div>
      );
    }

    return (
      <>
        {state.entries.map((entry) => {
          const isOpen = expanded.has(entry.path);
          const isSelected = selectedPath === entry.path;
          const isAiTouched = aiPath === entry.path;
          return (
            <div key={entry.path} className="work-tree-branch">
              <button
                type="button"
                className={`work-tree-row${entry.isDirectory ? ' is-dir' : ''}${
                  isSelected ? ' is-selected' : ''
                }${isAiTouched ? ' is-ai' : ''}`}
                style={indent}
                onClick={() => {
                  if (entry.isDirectory) toggleDir(entry.path);
                  else openFromTree(entry.path);
                }}
                aria-expanded={entry.isDirectory ? isOpen : undefined}
                title={entry.path}
              >
                <span className="work-tree-caret">
                  {entry.isDirectory ? (
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                  ) : null}
                </span>
                <Icon
                  name={isPreviewPath(entry.path) ? 'eye' : 'file'}
                  size={13}
                  className="work-tree-icon"
                />
                <span className="work-tree-name">{entry.name}</span>
                {entry.isSymbolicLink ? <span className="work-tree-tag">链接</span> : null}
                {entry.isDirectory ? null : (
                  <span className="work-tree-size">{formatBytes(entry.size)}</span>
                )}
              </button>
              {entry.isDirectory && isOpen ? renderDirectory(entry.path, depth + 1) : null}
            </div>
          );
        })}
      </>
    );
  }

  function renderCrumbs(): JSX.Element {
    return (
      <nav className="work-crumbs" aria-label="当前路径">
        <button
          type="button"
          className="work-crumb"
          onClick={() => expandPath('.')}
          title="工作区根目录"
        >
          工作区
        </button>
        {crumbs.map((part, index) => {
          const prefix = crumbs.slice(0, index + 1).join('/');
          const isLast = index === crumbs.length - 1;
          return (
            <span key={prefix} className="work-crumb-group">
              <span className="work-crumb-sep">/</span>
              {isLast ? (
                <span className="work-crumb is-current" title={selectedPath ?? ''}>
                  {part}
                </span>
              ) : (
                <button
                  type="button"
                  className="work-crumb"
                  onClick={() => expandPath(prefix)}
                  title={prefix}
                >
                  {part}
                </button>
              )}
            </span>
          );
        })}
      </nav>
    );
  }

  function renderView(): JSX.Element {
    if (view.kind === 'empty') {
      return (
        <div className="work-placeholder">
          <Icon name="file" size={30} />
          <h3>选择一个文件</h3>
          <p>
            左侧是本次会话的工作区。图片、PDF、Word、Excel 可以只读预览，文本可以编辑并保存。
          </p>
        </div>
      );
    }

    if (view.kind === 'loading') {
      return (
        <div className="work-placeholder" aria-busy="true">
          <span className="review-spinner" aria-hidden="true" />
          <h3>正在读取文件</h3>
          <p>{view.path}</p>
        </div>
      );
    }

    if (view.kind === 'error') {
      return (
        <div className="work-placeholder is-error" role="alert">
          <Icon name="alert" size={24} />
          <h3>打不开这个文件</h3>
          <p>{view.message}</p>
          <p className="work-placeholder-path">{view.path}</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openPath(view.path, 'user')}
          >
            重试
          </button>
        </div>
      );
    }

    if (view.kind === 'unsupported') {
      return (
        <div className="work-placeholder">
          <Icon name="file" size={28} />
          <h3>{view.message}</h3>
          <p>
            {baseNameOf(view.path)} ·{' '}
            {view.size === null ? '大小未知' : formatBytes(view.size)}
          </p>
          <p className="work-placeholder-path">{view.path}</p>
        </div>
      );
    }

    if (view.kind === 'image') {
      return (
        <div className="work-file">
          <header className="work-file-head">
            <div className="work-file-title">
              <span className="work-file-name" title={view.path}>
                {baseNameOf(view.path)}
              </span>
              <span className="work-file-path">{view.path}</span>
            </div>
            <div className="work-file-meta">
              <span>{view.size === null ? '大小未知' : formatBytes(view.size)}</span>
              {view.mtimeMs === null ? null : <span>{formatDateTime(view.mtimeMs)}</span>}
            </div>
            <div className="work-file-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setImageError(false);
                  setImageNonce((nonce) => nonce + 1);
                }}
                title="重新加载图片"
              >
                <Icon name="refresh" size={13} /> 刷新
              </button>
            </div>
          </header>
          {imageError ? (
            <div className="work-placeholder is-error" role="alert">
              <Icon name="alert" size={24} />
              <h3>图片加载失败</h3>
              <p>文件可能已被删除，或本地服务拒绝了这次读取。</p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setImageError(false);
                  setImageNonce((nonce) => nonce + 1);
                }}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="work-image">
              <img
                src={rawUrl(view.path, imageNonce)}
                alt={view.path}
                onError={() => setImageError(true)}
              />
            </div>
          )}
        </div>
      );
    }

    if (view.kind === 'preview-loading') {
      return (
        <div className="work-placeholder" aria-busy="true">
          <span className="review-spinner" aria-hidden="true" />
          <h3>正在生成预览</h3>
          <p>{view.path}</p>
        </div>
      );
    }

    if (view.kind === 'preview-error') {
      return (
        <div className="work-placeholder is-error" role="alert">
          <Icon name="alert" size={24} />
          <h3>无法预览这个文件</h3>
          <p>{view.message}</p>
          <p className="work-preview-hint">完整排版请用系统应用打开</p>
          <p className="work-placeholder-path">{view.path}</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openPath(view.path, 'user')}
          >
            重试
          </button>
        </div>
      );
    }

    if (view.kind === 'preview') {
      const preview = view.preview;
      return (
        <div className="work-file">
          <header className="work-file-head">
            <div className="work-file-title">
              <span className="work-file-name" title={view.path}>
                {baseNameOf(view.path)}
              </span>
              <span className="work-file-path">{view.path}</span>
            </div>
            <div className="work-file-meta">
              <span className="work-preview-tag">只读预览</span>
              <span>{view.size === null ? '大小未知' : formatBytes(view.size)}</span>
              {view.mtimeMs === null ? null : <span>{formatDateTime(view.mtimeMs)}</span>}
            </div>
            <div className="work-file-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void openPath(view.path, 'user')}
                title="重新生成预览"
              >
                <Icon name="refresh" size={13} /> 刷新
              </button>
            </div>
          </header>

          {preview.kind === 'pdf' ? (
            /**
             * ★ PDF 用浏览器内置查看器（iframe）渲染，旁边永远给一个"在新标签打开"。
             *   少数环境（无 PDF 插件的 Chromium、企业策略）里内嵌会空白甚至卡住，
             *   这时用户仍有一条可用的路。
             */
            <>
              <div className="work-preview-actions">
                <a className="text-btn" href={preview.url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={13} /> 在新标签打开
                </a>
              </div>
              <iframe
                key={`${view.path}:${previewNonce}`}
                className="work-preview-frame"
                src={preview.url}
                title={`PDF 预览：${view.path}`}
              />
            </>
          ) : preview.kind === 'text' ? (
            <>
              <p className="work-preview-note">
                <Icon name="info" size={13} />
                <span>{preview.note}</span>
              </p>
              <pre className="work-preview-text">{preview.text}</pre>
            </>
          ) : (
            <div className="work-table-wrap">
              <div className="work-table-caption">
                <span>工作表：{preview.sheet}</span>
                <span className="work-table-readonly" title={preview.note}>
                  只读
                </span>
              </div>
              <div className="work-table-scroll">
                {preview.rows.length === 0 ? (
                  <p className="work-table-empty">这个工作表没有内容。</p>
                ) : (
                  <table className="work-table">
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
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
              {preview.truncated ? (
                <div className="work-table-foot">内容过大，已截断</div>
              ) : null}
            </div>
          )}
        </div>
      );
    }

    // view.kind === 'text'
    return (
      <div className="work-file">
        <header className="work-file-head">
          <div className="work-file-title">
            <span className="work-file-name" title={view.path}>
              {baseNameOf(view.path)}
            </span>
            <span className="work-file-path">{view.path}</span>
          </div>
          {aiConflict !== null && aiConflict.path === view.path ? (
            <button
              type="button"
              className="work-ai-flag"
              onClick={loadAiVersion}
              title="AI 改过这个文件；载入最新版本会丢弃本地未保存的修改"
            >
              <Icon name="sparkle" size={12} />
              {aiConflict.writing ? 'AI 已写入' : 'AI 刚读过'} · 载入
            </button>
          ) : null}
          <div className="work-file-meta">
            <span className={`work-state${dirty ? ' is-dirty' : ''}`}>
              {dirty ? '未保存' : '已同步'}
            </span>
            <span>{formatBytes(view.size)}</span>
            <span title="最后修改时间">{formatDateTime(view.mtimeMs)}</span>
          </div>
          <div className="work-file-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowLineNumbers((shown) => !shown)}
              aria-pressed={showLineNumbers}
              title={showLineNumbers ? '隐藏行号' : '显示行号'}
            >
              行号
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
              title="保存（Ctrl/Cmd+S）"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </header>

        {saveError !== null ? (
          <div
            className={`work-alert${saveError.conflict ? ' is-warn' : ''}`}
            role="alert"
          >
            <span>{saveError.message}</span>
            {saveError.conflict ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void reloadCurrent()}
              >
                重新载入
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="work-editor">
          {showLineNumbers ? (
            <pre className="work-gutter" ref={gutterRef} aria-hidden="true">
              {lineNumbersText}
            </pre>
          ) : null}
          <textarea
            ref={editorRef}
            className="work-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            onScroll={handleEditorScroll}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`编辑 ${view.path}`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="work-panel">
      <aside className="work-tree" aria-label="工作区文件树">
        <div className="work-tree-head">
          <span className="work-tree-title">文件</span>
          <button
            type="button"
            className="work-icon-btn"
            onClick={refreshTree}
            title="刷新文件树"
            aria-label="刷新文件树"
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
        {renderCrumbs()}
        <div className="work-tree-scroll">{renderDirectory('.', 0)}</div>
      </aside>

      <div className="work-main">
        {aiNotice !== null && aiBannerVisible ? (
          <div
            className={`work-banner${aiNotice.writing ? ' is-write' : ' is-read'}${
              aiConflict !== null ? ' is-blocked' : ''
            }`}
            role="status"
          >
            <Icon name={aiNotice.writing ? 'pencil' : 'eye'} size={14} />
            <span className="work-banner-text">
              AI 正在{aiNotice.writing ? '写入' : '读取'} <code>{aiNotice.path}</code>
            </span>
            {aiConflict !== null ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadAiVersion}>
                载入 AI 版本
              </button>
            ) : null}
          </div>
        ) : null}
        {renderView()}
      </div>
    </div>
  );
}
