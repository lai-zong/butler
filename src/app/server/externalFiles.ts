/**
 * 外部文件面板的后端：句柄、预览、保存、监听与 AI 授权。
 *
 * ★★ 为什么不直接让前端传绝对路径：
 *   浏览器里拿到的是 File 对象，没有真实路径；而"原地保存 + AI 读写 +
 *   实时监听"都必须是路径级能力。直接开放 `?path=C:\...` 又等于把
 *   任意文件读写做成 HTTP 接口，任何跨站请求都能打。
 *
 *   所以用服务端原生选择框拿路径，登记成随机 handle；前端只拿 handle，
 *   所有读写都先查表并校验会话归属。句柄只活在进程内，重启即失效。
 *
 * ★ AI 授权是**按文件、按会话**的：用户打开文件不等于授权 AI；
 *   前端显式调用 grant 才把该路径加入当前会话的 allowlist，
 *   关闭面板时 revoke。授权路径会传给会话工具作用域的 pathGuard。
 */

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { OfficePreviewError, previewOffice, type OfficePreview } from './officePreview.js';
import { isPathInside } from './sessionWorkspace.js';

export type ExternalFileKind = 'text' | 'image' | 'pdf' | 'office' | 'unsupported';

export class ExternalFileError extends Error {
  override readonly name = 'ExternalFileError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'unsupported'
      | 'too_large'
      | 'forbidden'
      | 'conflict'
      | 'dialog_failed'
      | 'bad_handle',
  ) {
    super(message);
  }
}

export interface ExternalFileHandle {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: ExternalFileKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly editable: boolean;
  readonly etag: string;
  readonly sessionId: string;
}

interface HandleRecord {
  readonly id: string;
  readonly path: string;
  readonly sessionId: string;
  readonly kind: ExternalFileKind;
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.less', '.html',
  '.htm', '.xml', '.svg', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
  '.sql', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.env', '.gitignore',
  '.dockerfile', '.editorconfig',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);
const OFFICE_EXTS = new Set(['.docx', '.xlsx']);

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 40 * 1024 * 1024;

export function classifyExternalFile(path: string): ExternalFileKind {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (TEXT_EXTS.has(ext) || ext === '' || name === 'dockerfile' || name === 'makefile') return 'text';
  return 'unsupported';
}

function hashBytes(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

function normalizePath(path: string): string {
  const abs = resolve(path);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

const handles = new Map<string, HandleRecord>();
/** 会话 → 已授权路径（规范化绝对路径）。 */
const grants = new Map<string, Set<string>>();

export function externalGrantsFor(sessionId: string): readonly string[] {
  return [...(grants.get(sessionId) ?? [])];
}

export function grantExternalPath(sessionId: string, path: string): void {
  const abs = normalizePath(path);
  const set = grants.get(sessionId) ?? new Set<string>();
  set.add(abs);
  grants.set(sessionId, set);
}

export function revokeExternalPath(sessionId: string, path: string): void {
  const set = grants.get(sessionId);
  if (set === undefined) return;
  set.delete(normalizePath(path));
  if (set.size === 0) grants.delete(sessionId);
}

export function clearExternalGrants(sessionId: string): void {
  grants.delete(sessionId);
}

async function readEtag(path: string, kind: ExternalFileKind): Promise<string> {
  if (kind === 'text') {
    const buffer = await fs.readFile(path);
    return hashBytes(buffer);
  }
  const stat = await fs.stat(path);
  return `mtime-${stat.mtimeMs}-size-${stat.size}`;
}

function requireHandle(handle: string): HandleRecord {
  const record = handles.get(handle);
  if (record === undefined) {
    throw new ExternalFileError('文件句柄已失效，请重新打开', 'bad_handle');
  }
  return record;
}

export function externalHandle(handle: string, sessionId: string): HandleRecord {
  const record = requireHandle(handle);
  if (record.sessionId !== sessionId) {
    throw new ExternalFileError('该文件不属于当前会话', 'forbidden');
  }
  return record;
}

async function describe(record: HandleRecord): Promise<ExternalFileHandle> {
  const stat = await fs.stat(record.path).catch(() => null);
  if (stat === null) {
    throw new ExternalFileError('文件已被移动或删除', 'not_found');
  }
  const etag = await readEtag(record.path, record.kind);
  return {
    id: record.id,
    path: record.path,
    name: basename(record.path),
    kind: record.kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    editable: record.kind === 'text' && stat.size <= MAX_TEXT_BYTES,
    etag,
    sessionId: record.sessionId,
  };
}

function register(path: string, sessionId: string): HandleRecord {
  const abs = resolve(path);
  const id = randomBytes(12).toString('hex');
  const record: HandleRecord = { id, path: abs, sessionId, kind: classifyExternalFile(abs) };
  handles.set(id, record);
  return record;
}

/** 测试/内部用：不弹选择框，直接登记一个路径。 */
export async function registerExternalFile(path: string, sessionId: string): Promise<ExternalFileHandle> {
  if (!isAbsolute(path)) {
    throw new ExternalFileError('必须是绝对路径', 'unsupported');
  }
  const stat = await fs.stat(path).catch(() => null);
  if (stat === null || !stat.isFile()) {
    throw new ExternalFileError('文件不存在', 'not_found');
  }
  return describe(register(path, sessionId));
}

/**
 * 打开 Windows 原生选择框。
 *
 * ★ 用 PowerShell 的 WinForms OpenFileDialog：Node 没有原生文件对话框，
 *   而浏览器 `<input type=file>` 拿不到真实路径（更没法原地保存/AI 读写）。
 * ★ `-STA` 必须有：WinForms 对话框在线程模型上要求 STA，缺了会直接崩。
 */
export async function pickExternalFile(sessionId: string): Promise<ExternalFileHandle> {
  if (process.platform !== 'win32') {
    throw new ExternalFileError('当前平台不支持原生文件选择框', 'dialog_failed');
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = 'butler - 选择文件'",
    "$d.Filter = '支持的文件|*.txt;*.md;*.json;*.csv;*.log;*.js;*.ts;*.tsx;*.jsx;*.css;*.html;*.xml;*.yml;*.yaml;*.toml;*.ini;*.py;*.ps1;*.sh;*.bat;*.docx;*.xlsx;*.pdf;*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.svg|所有文件|*.*'",
    "if ($d.ShowDialog() -eq 'OK') {",
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  Write-Output $d.FileName',
    '}',
  ].join('\n');

  const output = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new ExternalFileError(error.message, 'dialog_failed')));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new ExternalFileError(err.trim() || `选择框退出码 ${String(code)}`, 'dialog_failed'));
        return;
      }
      resolvePromise(out.trim());
    });
  });

  const path = output.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  if (path === '') {
    throw new ExternalFileError('没有选择文件', 'dialog_failed');
  }
  const record = register(path, sessionId);
  return describe(record);
}

export async function closeExternalFile(handle: string, sessionId: string): Promise<void> {
  const record = externalHandle(handle, sessionId);
  revokeExternalPath(sessionId, record.path);
  handles.delete(handle);
}

export async function externalMeta(handle: string, sessionId: string): Promise<ExternalFileHandle> {
  return describe(externalHandle(handle, sessionId));
}

export async function externalText(handle: string, sessionId: string): Promise<{ text: string; etag: string }> {
  const record = externalHandle(handle, sessionId);
  const stat = await fs.stat(record.path);
  if (stat.size > MAX_TEXT_BYTES) {
    throw new ExternalFileError('文本超过 2MB，不适合在面板内编辑', 'too_large');
  }
  const buffer = await fs.readFile(record.path);
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new ExternalFileError('文件包含二进制内容，无法按文本编辑', 'unsupported');
  }
  return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), etag: hashBytes(buffer) };
}

export async function externalRaw(
  handle: string,
  sessionId: string,
): Promise<{ buffer: Buffer; mime: string; name: string }> {
  const record = externalHandle(handle, sessionId);
  const stat = await fs.stat(record.path);
  if (stat.size > MAX_RAW_BYTES) {
    throw new ExternalFileError('文件超过 40MB，不在面板内预览', 'too_large');
  }
  const buffer = await fs.readFile(record.path);
  const ext = extname(record.path).toLowerCase();
  const mime =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.bmp'
                ? 'image/bmp'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : 'application/octet-stream';
  return { buffer, mime, name: basename(record.path) };
}

export async function externalOfficePreview(
  handle: string,
  sessionId: string,
): Promise<OfficePreview> {
  const record = externalHandle(handle, sessionId);
  const buffer = await fs.readFile(record.path);
  return previewOffice(buffer, extname(record.path).toLowerCase());
}

export async function saveExternalText(
  handle: string,
  sessionId: string,
  text: string,
  etag: string,
): Promise<{ etag: string; mtimeMs: number }> {
  const record = externalHandle(handle, sessionId);
  if (record.kind !== 'text') {
    throw new ExternalFileError('该文件不是可编辑文本', 'unsupported');
  }
  const current = await fs.readFile(record.path);
  if (hashBytes(current) !== etag) {
    throw new ExternalFileError('文件已被其它程序修改，请先刷新再保存', 'conflict');
  }
  const tmp = join(dirname(record.path), `.butler-save-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, record.path);
  const stat = await fs.stat(record.path);
  return { etag: hashBytes(Buffer.from(text, 'utf8')), mtimeMs: stat.mtimeMs };
}

// ── 监听 ───────────────────────────────────────────────────────────

export interface ExternalFileEvent {
  readonly type: 'changed' | 'deleted' | 'error';
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly etag?: string;
  readonly message?: string;
}

interface WatchEntry {
  readonly watcher: FSWatcher;
  readonly emitter: EventEmitter;
  subscribers: number;
  timer: NodeJS.Timeout | null;
  readonly onFsEvent: () => void;
}

const watchers = new Map<string, WatchEntry>();

function watchKey(record: HandleRecord): string {
  return record.path.toLowerCase();
}

async function emitChange(record: HandleRecord, entry: WatchEntry): Promise<void> {
  try {
    const stat = await fs.stat(record.path);
    const etag = await readEtag(record.path, record.kind);
    entry.emitter.emit('event', {
      type: 'changed',
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      etag,
    } satisfies ExternalFileEvent);
  } catch {
    entry.emitter.emit('event', { type: 'deleted' } satisfies ExternalFileEvent);
  }
}

export function subscribeExternalFile(
  handle: string,
  sessionId: string,
  listener: (event: ExternalFileEvent) => void,
): () => void {
  const record = externalHandle(handle, sessionId);
  const key = watchKey(record);
  let entry = watchers.get(key);
  if (entry === undefined) {
    const emitter = new EventEmitter();
    const onFsEvent = (): void => {
      const current = watchers.get(key);
      if (current === undefined) return;
      if (current.timer !== null) clearTimeout(current.timer);
      // 一次保存通常触发多个 fs 事件；合并成 150ms 后的一次读取。
      current.timer = setTimeout(() => {
        current.timer = null;
        void emitChange(record, current);
      }, 150);
    };
    const watcher = watch(dirname(record.path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString().toLowerCase() === basename(record.path).toLowerCase()) {
        onFsEvent();
      }
    });
    watcher.on('error', () => {
      emitter.emit('event', { type: 'error', message: '文件监听失败' } satisfies ExternalFileEvent);
    });
    entry = { watcher, emitter, subscribers: 0, timer: null, onFsEvent };
    watchers.set(key, entry);
  }
  entry.subscribers += 1;
  entry.emitter.on('event', listener);
  return () => {
    const current = watchers.get(key);
    if (current === undefined) return;
    current.emitter.off('event', listener);
    current.subscribers -= 1;
    if (current.subscribers <= 0) {
      if (current.timer !== null) clearTimeout(current.timer);
      current.watcher.close();
      watchers.delete(key);
    }
  };
}

export function isGrantableExternalPath(path: string, protectedPaths: readonly string[]): boolean {
  const abs = resolve(path);
  return !protectedPaths.some((protectedPath) => isPathInside(protectedPath, abs));
}

export const externalFileLimits = { MAX_TEXT_BYTES, MAX_RAW_BYTES } as const;

export { OfficePreviewError };
