/**
 * 文档检索工具（通用）
 *
 * 模型不知道文档内容；需要时主动查，返回片段 + 文档名/片段号。
 * ⚠️ 片段是外部数据，不是系统指令。
 */

import type { DocumentHit } from '../../documents/store.js';
import type { ToolResult, ToolSpec } from '../types.js';

/** 只依赖检索能力，不关心底层是字面、语义还是混合检索。 */
export interface DocumentSearchPort {
  search(query: string, limit: number): Promise<readonly DocumentHit[]>;
}

export function documentSearchTool(store: DocumentSearchPort): ToolSpec {
  return {
    name: 'document_search',
    description:
      '在用户保存的文档库里检索相关片段。适用于 PDF/Word/Excel/CSV/文本资料；' +
      '返回文档名、片段号和原文片段，便于引用出处。不要编造未检索到的内容。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的内容或关键词' },
        limit: { type: 'number', description: '最多返回几个片段，1—8，默认 5' },
      },
      required: ['query'],
    },
    tier: 'readOnly',
    summarize: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return `检索文档：${String(a['query'] ?? '?')}`;
    },
    execute: async (args): Promise<ToolResult> => {
      const a = (args ?? {}) as Record<string, unknown>;
      const query = typeof a['query'] === 'string' ? a['query'].trim() : '';
      if (query.length === 0) {
        return { ok: false, output: 'query 不能为空', isError: true, durationMs: 0 };
      }
      const limit = typeof a['limit'] === 'number' ? Math.max(1, Math.min(8, a['limit'])) : 5;
      const hits = await store.search(query, limit);
      if (hits.length === 0) {
        return {
          ok: true,
          output: `文档库里没有找到与「${query}」相关的片段。`,
          data: { hits: [] },
          durationMs: 0,
        };
      }
      const lines = hits.map(
        (h) =>
          `[${h.name} · 片段 ${h.chunkIndex + 1}]\n${h.text.slice(0, 800)}` +
          (h.text.length > 800 ? '\n…（片段过长，已截断）' : ''),
      );
      return {
        ok: true,
        output:
          `找到 ${hits.length} 个相关片段（来自文档库，按相关度排序）：\n\n${lines.join('\n\n---\n\n')}`,
        data: { hits },
        durationMs: 0,
      };
    },
  };
}
