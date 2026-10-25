/**
 * 产出物 ICS 导出
 *
 * ★ 这里导出的是 **VTODO（任务清单）**，不是带时间的 VEVENT。
 *   当前产出物没有结构化日期字段；从“下周三”这类正文猜日期会错。
 *   VTODO 可以合法地没有 DUE，导入日历/任务应用后就是一条待办。
 *
 * ★ 不伪造时间：没有日期就不写 DTSTART/DUE，而不是随便填一个。
 */

import type { Artifact, ArtifactRevision } from '@/core/artifact/types.js';

export interface IcsExport {
  readonly filename: string;
  readonly content: string;
  readonly todoCount: number;
}

function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function safeFilename(label: string): string {
  const base = label.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80);
  return `${base.length > 0 ? base : 'artifact'}.ics`;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function artifactToIcs(artifact: Artifact, revision: ArtifactRevision): IcsExport {
  const rows =
    revision.items !== undefined && revision.items.length > 0
      ? revision.items
      : revision.content.split(/\r?\n/).filter((line) => line.length > 0);
  const dtstamp = stamp(artifact.updatedAt);
  const body = rows
    .map(
      (row, i) => [
        'BEGIN:VTODO',
        `UID:${artifact.id}-${revision.version}-${i}@butler.local`,
        `DTSTAMP:${dtstamp}`,
        `SUMMARY:${icsText(row.slice(0, 200))}`,
        'STATUS:NEEDS-ACTION',
        'END:VTODO',
      ].join('\r\n'),
    )
    .join('\r\n');

  return {
    filename: safeFilename(artifact.label),
    todoCount: rows.length,
    content: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//butler//artifact//CN',
      'CALSCALE:GREGORIAN',
      body,
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  };
}
