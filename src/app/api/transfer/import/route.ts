/**
 * 数据导入端点（v8 · 方案 §5.5）
 *
 * `POST /api/transfer/import`  body = 导出文档的原始 JSON 文本
 *
 * ★★ 顺序是这个端点唯一重要的东西（每一步都有事故依据）：
 *
 *   ① **校验**（纯逻辑）—— 不通过就明确拒绝，不碰任何文件
 *   ② **备份现有事件文件** —— 导入是破坏性操作；用户点错一次不该丢全部历史
 *   ③ **写入**（原子替换：先写临时文件再 rename）
 *   ④ **重置运行时** —— forced：导入的事件 seq 从 1 开始，
 *      而运行中的 log 已经有自己的 seq。往它追加必然撞号。
 *      `bootstrap.ts` 注释里记录过真实后果：
 *      「磁盘上出现两个 seq=1，读回时按 seq 去重，历史悄悄少了一条」
 *   ⑤ **重新 bootstrap** 并返回重建摘要 —— 让用户看到"真的导进来了多少"
 *
 * ⚠️ 不做"合并"：方案要求的是"导出→导入→状态等价"，
 *    合并两份历史会让同一个 seq 有两套语义，那是数据损坏而不是功能。
 */

import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DATA_DIR, eventsFile, getRuntime, resetRuntime } from '@/app/runtime';
import { describeRejection, parseImportDocument } from '@/core/transfer/import.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 请求体上限：一份全量事件流可能几 MB，给到 64MB */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── ① 读取原始文本 ──
  const raw = await req.text();
  if (raw.length === 0) {
    return NextResponse.json({ error: '请求体为空' }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `导入文件过大（${raw.length} 字节 > 上限 ${MAX_BODY_BYTES}）` },
      { status: 413 },
    );
  }

  // ── ② 校验（纯逻辑，不碰文件） ──
  const parsed = parseImportDocument(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: describeRejection(parsed.rejection), rejection: parsed.rejection },
      { status: 400 },
    );
  }
  const { doc, eventCount } = parsed.candidate;

  // ── ③ 备份现有事件文件 ──
  const file = eventsFile(DATA_DIR);
  const backup = `${file}.before-import-${doc.exportedAt}`;
  let backedUp = false;
  try {
    await copyFile(file, backup);
    backedUp = true;
  } catch {
    // 首次运行没有 events.jsonl —— 没有可备份的东西，不算失败
    backedUp = false;
  }

  // ── ④ 原子写入（写临时文件再 rename）──
  //
  // ⚠️ 直接覆盖原文件的话，写到一半崩溃 = 历史全毁。
  //    先写 .tmp 再 rename 是"要么全成、要么全不变"。
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.importing-${doc.exportedAt}`;
  const body = doc.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);

  // ── ⑤ 重置运行时并重建 ──
  await resetRuntime();
  const rt = await getRuntime();

  return NextResponse.json({
    ok: true,
    imported: {
      events: eventCount,
      lastSeq: doc.counts.lastSeq,
      exportedAt: doc.exportedAt,
      userId: doc.userId,
      appVersion: doc.appVersion,
    },
    backup: backedUp ? backup : null,
    // 重建摘要 —— 让用户看到"真的导进来了多少"，而不是只看一个 ok
    restored: rt.bootstrapped.restored,
    historicalEvents: rt.bootstrapped.historicalEvents,
  });
}
