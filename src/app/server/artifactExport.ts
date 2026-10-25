/**
 * 产出物 CSV 导出（后端）
 *
 * 方案 §5.3 要求产出物可下载 CSV / ICS / PDF。当前先实现可判定的 CSV：
 *   · list / plan：每个条目一行；
 *   · text / file / code：按行拆分；
 *   · 不伪造 ICS 日期或 PDF 排版 —— 未实现的格式明确返回 400。
 */

import type { Artifact, ArtifactRevision } from '@/core/artifact/types.js';

export interface CsvExport {
  readonly filename: string;
  readonly content: string;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function safeFilename(label: string): string {
  const base = label.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80);
  return `${base.length > 0 ? base : 'artifact'}.csv`;
}

export function artifactToCsv(artifact: Artifact, revision: ArtifactRevision): CsvExport {
  const rows =
    revision.items !== undefined && revision.items.length > 0
      ? revision.items
      : revision.content.split(/\r?\n/).filter((line) => line.length > 0);

  const content = `内容\r\n${rows.map((row) => csvCell(row)).join('\r\n')}\r\n`;
  return { filename: safeFilename(artifact.label), content };
}
