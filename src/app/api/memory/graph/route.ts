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

type EdgeType = 'content' | 'sharedEvidence' | 'conflict' | 'merge' | 'coRecall';

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

  // ① 内容相似：每个节点只保留最强的几条，避免毛线团。
  const contentEdges: { a: string; b: string; weight: number }[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (!b) continue;
      if (a.memClass !== b.memClass || a.kind !== b.kind) continue;
      const w = similarity(a.content, b.content);
      if (w >= CONTENT_EDGE_FLOOR) contentEdges.push({ a: a.id, b: b.id, weight: w });
    }
  }
  contentEdges.sort((x, y) => y.weight - x.weight);
  const perNode = new Map<string, number>();
  for (const e of contentEdges) {
    const ca = perNode.get(e.a) ?? 0;
    const cb = perNode.get(e.b) ?? 0;
    if (ca >= 3 || cb >= 3) continue;
    addEdge(e.a, e.b, 'content', e.weight, `内容相似 ${Math.round(e.weight * 100)}%`);
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

  // ③ 冲突事件（只取双方仍在图中的）
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
      '内容相似边是确定性文本相似度预览；正式语义边应使用 embedding。' +
      '同轮召回边需要召回批次标识，当前事件模型暂未提供。',
  });
}
