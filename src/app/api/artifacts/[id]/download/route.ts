/**
 * 产出物下载（后端 + 设置页已接入）
 *
 * GET /api/artifacts/[id]/download?format=csv|ics|pdf
 *
 * CSV 是确定性文本；ICS 是 VTODO 任务清单（不猜日期）；PDF 用本机 Edge/Chrome 打印。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { artifactToCsv } from '@/app/server/artifactExport.js';
import { artifactToIcs } from '@/app/server/artifactIcs.js';
import { artifactToPdf } from '@/app/server/artifactPdf.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const format = (req.nextUrl.searchParams.get('format') ?? 'csv').trim().toLowerCase();
  if (format !== 'csv' && format !== 'pdf' && format !== 'ics') {
    return NextResponse.json(
      { error: `暂不支持 ${format} 导出；当前支持 csv / ics / pdf` },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const artifact = rt.bootstrapped.artifacts.get(id);
  if (artifact === undefined) {
    return NextResponse.json({ error: '找不到这个产出物' }, { status: 404 });
  }
  const revision = rt.bootstrapped.artifacts.currentRevision(id);
  if (revision === undefined) {
    return NextResponse.json({ error: '这个产出物没有可用版本' }, { status: 409 });
  }

  const exported = artifactToCsv(artifact, revision);
  // HTTP 头是 Latin-1；中文文件名只能走 RFC 5987 的 filename*，
  // 同时保留一个 ASCII fallback，避免 Node 直接抛 ERR_INVALID_CHAR。
  const asciiName = exported.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(exported.filename);
  if (format === 'pdf') {
    try {
      const pdf = await artifactToPdf(artifact, revision);
      const pdfName = exported.filename.replace(/\.csv$/i, '.pdf');
      const pdfAscii = pdfName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${pdfAscii}"; filename*=UTF-8''${encodeURIComponent(pdfName)}`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'PDF 导出失败' },
        { status: 503 },
      );
    }
  }
  if (format === 'ics') {
    const ics = artifactToIcs(artifact, revision);
    const icsAscii = ics.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new NextResponse(ics.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${icsAscii}"; filename*=UTF-8''${encodeURIComponent(ics.filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return new NextResponse(exported.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    },
  });
}
