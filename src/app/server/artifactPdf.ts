/**
 * 产出物 PDF 导出（本机 Edge 打印）
 *
 * ★ 不引入 PDF 依赖、不伪造排版：
 *   把产出物渲染成一个最小 HTML，再调用本机 Edge/Chrome 的
 *   `--print-to-pdf`。中文字体由系统浏览器处理。
 *
 * ★ 只有实际生成出非空 PDF 才返回；失败如实报错，不返回空文件。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Artifact, ArtifactRevision } from '@/core/artifact/types.js';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const PRINT_TIMEOUT_MS = 30_000;
const MAX_HTML_CONTENT = 200_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function artifactToHtml(artifact: Artifact, revision: ArtifactRevision): string {
  const lines =
    revision.items !== undefined && revision.items.length > 0
      ? revision.items
      : revision.content.split(/\r?\n/).filter((line) => line.length > 0);
  const body = lines
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(artifact.label)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { color: #1e1d19; font-family: "Microsoft YaHei", "Noto Sans SC", "SimSun", sans-serif; font-size: 11pt; line-height: 1.75; }
  h1 { margin: 0 0 14px; font-size: 20pt; font-weight: 600; letter-spacing: -.02em; }
  .meta { margin-bottom: 18px; padding-bottom: 10px; border-bottom: 1px solid #d3cec1; color: #726c61; font: 9pt "Cascadia Code", monospace; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid #e4e0d5; color: #8a8478; font-size: 8pt; }
</style>
</head>
<body>
<h1>${escapeHtml(artifact.label)}</h1>
<div class="meta">butler · 产出物 · v${revision.version} · ${new Date(artifact.updatedAt).toISOString().slice(0, 10)}</div>
<ul>${body}</ul>
<div class="footer">由 butler 本地导出 · 原文保存在本机事件流中</div>
</body>
</html>`;
}

function findBrowser(): string | null {
  const fromEnv = process.env['BUTLER_EDGE_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export async function artifactToPdf(artifact: Artifact, revision: ArtifactRevision): Promise<Buffer> {
  const browser = findBrowser();
  if (browser === null) {
    throw new Error('PDF 导出需要本机 Edge/Chrome；当前未找到浏览器。');
  }

  const html = artifactToHtml(artifact, revision);
  if (html.length > MAX_HTML_CONTENT) {
    throw new Error('产出物内容过大，无法生成 PDF。');
  }

  const dir = await mkdtemp(join(tmpdir(), 'butler-pdf-'));
  const htmlPath = join(dir, 'artifact.html');
  const pdfPath = join(dir, 'artifact.pdf');
  try {
    await writeFile(htmlPath, html, 'utf8');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-pdf-header-footer',
          '--disable-extensions',
          `--user-data-dir=${join(dir, 'profile')}`,
          `--print-to-pdf=${pdfPath}`,
          pathToFileURL(htmlPath).toString(),
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('PDF 生成超时（30 秒）。'));
      }, PRINT_TIMEOUT_MS);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`PDF 生成失败（浏览器退出码 ${String(code)}）。`));
      });
    });
    const pdf = await readFile(pdfPath);
    if (pdf.length === 0) throw new Error('PDF 生成结果为空。');
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
