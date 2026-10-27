/**
 * 记忆关系图 —— 只读派生投影，不是新的真相源。
 *
 * 节点是记忆；边来自：
 *   · 内容相似（确定性相似度，正式版可替换为 embedding）
 *   · 共享证据
 *   · 冲突事件
 *   · 合并来源
 *
 * 不持久化图；删除记忆后节点与边自然消失。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { toMemoryDto } from '@/app/server/uiData.js';
import type { MemoryEntry } from '@/core/memory/types.js';
import { similarity } from '@/core/memory/sink.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_NODES = 200;
const MAX_EDGES = 600;
const CONTENT_EDGE_FLOOR = 0.38;

type EdgeType = 'content' | 'semantic' | 'sharedEvidence' | 'conflict' | 'merge' | 'coRecall';

interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: EdgeType;
  readonly weight: number;
  readonly reason?: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const nodes = [...store.all()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_NODES);
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (
    source: string,
    target: string,
    type: EdgeType,
    weight: number,
    reason?: string,
  ): void => {
    if (source === target || !ids.has(source) || !ids.has(target)) return;
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`;
    const key = `${type}|${pair}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: `edge_${edges.length}`,
      source,
      target,
      type,
      weight: Math.max(0, Math.min(1, weight)),
      ...(reason !== undefined ? { reason } : {}),
    });
  };

  // ① 语义相似：优先用 embedding；模型不可用时降级为确定性文本相似。
  // 每个节点只保留最强的几条，避免毛线团。
  let semanticPairs: ReadonlyMap<string, ReadonlyMap<string, number>> | null = null;
  if (process.env.MEMORY_GRAPH_LEXICAL !== '1' && nodes.length > 1) {
    try {
      semanticPairs = await rt.semantic.pairwise(nodes);
    } catch {
      semanticPairs = null;
    }
  }

  const contentEdges: { a: string; b: string; weight: number; semantic: boolean }[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (!b) continue;
      if (a.memClass !== b.memClass || a.kind !== b.kind) continue;
      const semanticWeight = semanticPairs?.get(a.id)?.get(b.id);
      const w = semanticWeight ?? similarity(a.content, b.content);
      const floor = semanticWeight !== undefined ? 0.62 : CONTENT_EDGE_FLOOR;
      if (w >= floor) {
        contentEdges.push({
          a: a.id,
          b: b.id,
          weight: w,
          semantic: semanticWeight !== undefined,
        });
      }
    }
  }
  contentEdges.sort((x, y) => y.weight - x.weight);
  const perNode = new Map<string, number>();
  for (const e of contentEdges) {
    const ca = perNode.get(e.a) ?? 0;
    const cb = perNode.get(e.b) ?? 0;
    if (ca >= 3 || cb >= 3) continue;
    addEdge(
      e.a,
      e.b,
      e.semantic ? 'semantic' : 'content',
      e.weight,
      `${e.semantic ? '语义' : '文本'}相似 ${Math.round(e.weight * 100)}%`,
    );
    perNode.set(e.a, ca + 1);
    perNode.set(e.b, cb + 1);
    if (edges.length >= MAX_EDGES) break;
  }

  // ② 共享证据
  const byEvidence = new Map<string, string[]>();
  for (const n of nodes) {
    for (const ev of new Set(n.evidence)) {
      // 日记日期标记不是“同一段证据”，不据此连所有同日记忆。
      if (ev.startsWith('diary:')) continue;
      const list = byEvidence.get(ev) ?? [];
      list.push(n.id);
      byEvidence.set(ev, list);
    }
  }
  for (const [ev, list] of byEvidence) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!a || !b) continue;
        addEdge(a, b, 'sharedEvidence', 0.8, `共享证据 ${ev}`);
        if (edges.length >= MAX_EDGES) break;
      }
    }
  }

  // ③ 同轮召回：同一批次进入上下文的记忆之间建立弱边。
  const byBatch = new Map<string, string[]>();
  for (const event of rt.bootstrapped.log.byType('memory.recalled')) {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const memoryId = asString(p['memoryId']);
    const batchId = asString(p['batchId']);
    if (memoryId.length === 0 || batchId.length === 0) continue;
    const list = byBatch.get(batchId) ?? [];
    if (!list.includes(memoryId)) list.push(memoryId);
    byBatch.set(batchId, list);
  }
  for (const list of byBatch.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!a || !b) continue;
        addEdge(a, b, 'coRecall', 0.65, '同一轮召回');
        if (edges.length >= MAX_EDGES) break;
      }
    }
  }

  // ④ 冲突事件（只取双方仍在图中的）
  for (const event of rt.bootstrapped.log.byType('conflict.detected')) {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const memoryId = asString(p['memoryId']);
    const otherIds = Array.isArray(p['memoryIds'])
      ? p['memoryIds'].filter((x): x is string => typeof x === 'string')
      : [];
    for (const other of otherIds) {
      addEdge(memoryId, other, 'conflict', 1, asString(p['reason']) || '检测到冲突');
      if (edges.length >= MAX_EDGES) break;
    }
  }

  // ④ 合并来源
  for (const n of nodes) {
    for (const source of n.mergedFrom ?? []) {
      addEdge(n.id, source, 'merge', 1, '合并来源');
      if (edges.length >= MAX_EDGES) break;
    }
  }

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    nodes: nodes.map((n: MemoryEntry) => ({
      ...toMemoryDto(n),
      degree: degree.get(n.id) ?? 0,
    })),
    edges,
    total: { nodes: nodes.length, edges: edges.length },
    note:
      semanticPairs !== null
        ? '语义边来自 embedding；同轮召回边只对带 batchId 的新召回事件生效。'
        : '当前嵌入模型不可用，内容边降级为确定性文本相似；同轮召回边只对带 batchId 的新召回事件生效。',
  });
}
