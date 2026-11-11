/**
 * 文档/表格提取（PDF / DOCX / XLSX / CSV / TXT / MD）
 *
 * 只负责把文件变成纯文本，供用户在发送前确认/编辑。
 * ⚠️ 提取出来的内容仍是**外部数据**，不是系统指令。
 */

import { execFile } from 'node:child_process';

import { DEFAULT_ENV_WHITELIST } from '@/adapters/exec/node.js';

/** 只带白名单变量 + 调用方显式追加的项。 */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DEFAULT_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set(['.pdf', '.docx', '.xlsx', '.xlsm', '.csv', '.txt', '.md', '.json']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: '请求不是合法的 multipart 表单' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: '文件为空' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: '文件超过 20 MiB 上限' }, { status: 413 });
  }

  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED.has(ext)) {
    return NextResponse.json(
      { error: `不支持的文档类型：${ext || '(无扩展名)'}` },
      { status: 400 },
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'butler-doc-'));
  const path = join(dir, `input${ext}`);
  try {
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    const script = resolve(process.cwd(), 'scripts', 'extract_document.py');
    let stdout = '';
    try {
      const result = await execFileAsync(process.env['PYTHON'] ?? 'python', [script, path], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        /**
         * ⚠️ 不能 `{ ...process.env }`：解析不可信 PDF/DOCX 的子进程
         *    （以及被 exploit 的解析器代码）能读到 `DEEPSEEK_API_KEY`。
         *    只给系统必需项 + Python 自己的两个变量。
         */
        env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) as NodeJS.ProcessEnv,
      });
      stdout = result.stdout;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `文档解析进程失败；需要本机 Python 与 pypdf/python-docx/openpyxl。${detail}` },
        { status: 503 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return NextResponse.json({ error: '文档解析返回了非法 JSON' }, { status: 500 });
    }
    const rec = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    if (rec['ok'] !== true || typeof rec['text'] !== 'string') {
      return NextResponse.json(
        { error: typeof rec['error'] === 'string' ? rec['error'] : '文档解析失败' },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true,
      kind: typeof rec['kind'] === 'string' ? rec['kind'] : ext.slice(1),
      fileName: file.name,
      text: rec['text'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
