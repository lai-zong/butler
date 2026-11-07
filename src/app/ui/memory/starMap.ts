/**
 * 记忆星图 —— 布局与星体配色
 *
 * 三条刻意的约束：
 *   ① 位置**可复现**：同一批记忆每次打开都长成同一片星空，
 *      不用每次刷新的随机撒点去制造“热闹”。
 *   ② 2D 与 3D 是同一批星体的两种投影。布局一次算两份坐标，
 *      切换时做位置补间，而不是换一套数据重新排。
 *   ③ 布局在加载时算完，渲染循环只负责投影、旋转与呼吸 ——
 *      星空可以复杂，每一帧必须便宜。
 */

import type {
  MemoryEdgeType,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryItem,
  MemoryKind,
  MemoryLifecycle,
} from '../lib/types.js';

export type MapMode = '2d' | '3d';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StarNode {
  readonly id: string;
  readonly item: MemoryItem;
  readonly degree: number;
  /** 2D 星图坐标（归一化到约 ±1）。 */
  readonly p2: Vec2;
  /** 3D 星云坐标（单位球内）。 */
  readonly p3: Vec3;
  /** 基准像素半径（zoom=1、无透视时）。 */
  readonly radius: number;
  readonly color: string;
  readonly rgb: readonly [number, number, number];
  readonly phase: number;
}

export interface StarEdge {
  readonly id: string;
  readonly a: number;
  readonly b: number;
  readonly type: MemoryEdgeType;
  readonly weight: number;
  readonly reason: string | null;
  /** 弯曲方向，避免同一对星体之间的多条关系完全重叠。 */
  readonly curve: number;
}

export interface StarMap {
  readonly nodes: readonly StarNode[];
  readonly edges: readonly StarEdge[];
  readonly index: ReadonlyMap<string, number>;
}

// ═══════════════════════════════════════════════════════════
// 视觉常量
// ═══════════════════════════════════════════════════════════

export const LIFECYCLE_ORDER: readonly MemoryLifecycle[] = [
  'active',
  'candidate',
  'dormant',
  'archived',
];

export const LIFECYCLE_RGB: Record<MemoryLifecycle, readonly [number, number, number]> = {
  active: [139, 240, 214],
  candidate: [244, 197, 140],
  dormant: [156, 180, 232],
  archived: [147, 163, 158],
};

export const LIFECYCLE_COLOR: Record<MemoryLifecycle, string> = {
  active: '#8bf0d6',
  candidate: '#f4c58c',
  dormant: '#9cb4e8',
  archived: '#93a39e',
};

export interface EdgeMeta {
  readonly label: string;
  readonly rgb: readonly [number, number, number];
  readonly dashed: boolean;
}

export const EDGE_META: Record<MemoryEdgeType, EdgeMeta> = {
  semantic: { label: '语义相似', rgb: [127, 224, 195], dashed: false },
  content: { label: '文本相似', rgb: [143, 199, 230], dashed: false },
  sharedEvidence: { label: '共享证据', rgb: [167, 186, 255], dashed: false },
  conflict: { label: '冲突', rgb: [229, 139, 122], dashed: true },
  merge: { label: '合并来源', rgb: [195, 166, 240], dashed: false },
  coRecall: { label: '同轮召回', rgb: [139, 214, 166], dashed: false },
};

/** 图例顺序：越靠前越“值得先看”。 */
export const EDGE_ORDER: readonly MemoryEdgeType[] = [
  'semantic',
  'content',
  'sharedEvidence',
  'conflict',
  'merge',
  'coRecall',
];

export function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// ═══════════════════════════════════════════════════════════
// 确定性随机
// ═══════════════════════════════════════════════════════════

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 0..1 的确定性随机：同一个 id + 同一个 salt 永远得到同一个数。 */
function hash01(id: string, salt: number): number {
  let t = (hashString(`${id}#${salt}`) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function easeOutCubic(t: number): number {
  const p = clamp01(t);
  return 1 - (1 - p) ** 3;
}

export { easeOutCubic };

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** 内容命中：只用于从其它空间带过来的检索意图，不在星图上显示文字。 */
export function matchesQuery(item: MemoryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystack = [
    item.content,
    item.subject ?? '',
    item.kindLabel,
    item.memClassLabel,
    item.lifecycleLabel,
    item.domainLabel ?? '',
    item.principle?.condition ?? '',
    item.principle?.action ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

// ═══════════════════════════════════════════════════════════
// 2D 布局：按记忆种类分簇，再让它自己长成星座
// ═══════════════════════════════════════════════════════════

const KIND_ORDER: readonly MemoryKind[] = ['fact', 'preference', 'principle', 'summary'];

const ANCHORS_2D: readonly (readonly Vec2[])[] = [
  [{ x: 0, y: 0 }],
  [
    { x: -0.38, y: -0.1 },
    { x: 0.4, y: 0.12 },
  ],
  [
    { x: -0.44, y: -0.22 },
    { x: 0.46, y: -0.2 },
    { x: -0.02, y: 0.42 },
  ],
  [
    { x: -0.48, y: -0.28 },
    { x: 0.5, y: -0.3 },
    { x: -0.44, y: 0.38 },
    { x: 0.46, y: 0.36 },
  ],
];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function presentKinds(nodes: readonly MemoryGraphNode[]): readonly MemoryKind[] {
  return KIND_ORDER.filter((kind) => nodes.some((n) => n.kind === kind));
}

function anchorsFor(kinds: readonly MemoryKind[], set: readonly (readonly Vec2[])[]): Map<MemoryKind, Vec2> {
  const list = set[Math.max(1, Math.min(kinds.length, set.length)) - 1] ?? set[0] ?? [{ x: 0, y: 0 }];
  const map = new Map<MemoryKind, Vec2>();
  kinds.forEach((kind, i) => {
    map.set(kind, list[i] ?? { x: 0, y: 0 });
  });
  return map;
}

function layout2d(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): Vec2[] {
  const kinds = presentKinds(nodes);
  const anchors = anchorsFor(kinds, ANCHORS_2D);
  const seen = new Map<MemoryKind, number>();

  const pos: Vec2[] = nodes.map((node) => {
    const kind = node.kind;
    const indexInKind = seen.get(kind) ?? 0;
    seen.set(kind, indexInKind + 1);

    const anchor = anchors.get(kind) ?? { x: 0, y: 0 };
    const angle = indexInKind * GOLDEN_ANGLE + hash01(node.id, 1) * 1.8;
    const radius =
      indexInKind === 0
        ? hash01(node.id, 2) * 0.05
        : 0.07 + Math.sqrt(indexInKind) * 0.085 * (0.75 + hash01(node.id, 3) * 0.5);

    return {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius * 0.92,
    };
  });

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const minGap = 0.15;
  const iterations = 190;

  for (let iter = 0; iter < iterations; iter += 1) {
    // 斥力：让每颗星都有自己的空间。
    for (let i = 0; i < pos.length; i += 1) {
      const a = pos[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < pos.length; j += 1) {
        const b = pos[j];
        if (b === undefined) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-8) {
          dx = (hash01(nodes[i]?.id ?? String(i), 5) - 0.5) * 0.02;
          dy = (hash01(nodes[j]?.id ?? String(j), 6) - 0.5) * 0.02;
          d2 = dx * dx + dy * dy + 1e-8;
        }
        const d = Math.sqrt(d2);
        if (d >= minGap) continue;
        const push = ((minGap - d) / d) * 0.52;
        (a as { x: number; y: number }).x -= dx * push;
        (a as { x: number; y: number }).y -= dy * push;
        (b as { x: number; y: number }).x += dx * push;
        (b as { x: number; y: number }).y += dy * push;
      }
    }

    // 关系弹簧：有连接的记忆自然靠近。
    for (const edge of edges) {
      const ai = nodeIndex.get(edge.source);
      const bi = nodeIndex.get(edge.target);
      if (ai === undefined || bi === undefined) continue;
      const a = pos[ai];
      const b = pos[bi];
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-5) continue;
      const target = 0.36 - 0.13 * edge.weight;
      const force = (d - target) * 0.013 * (0.5 + edge.weight);
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      (a as { x: number; y: number }).x += fx;
      (a as { x: number; y: number }).y += fy;
      (b as { x: number; y: number }).x -= fx;
      (b as { x: number; y: number }).y -= fy;
    }

    // 弱回拉：别让某个簇漂走，也别塌成一团。
    for (let i = 0; i < pos.length; i += 1) {
      const p = pos[i];
      const node = nodes[i];
      if (p === undefined || node === undefined) continue;
      const anchor = anchors.get(node.kind) ?? { x: 0, y: 0 };
      (p as { x: number; y: number }).x += (anchor.x - p.x) * 0.0075;
      (p as { x: number; y: number }).y += (anchor.y - p.y) * 0.0075;
      (p as { x: number; y: number }).x -= p.x * 0.0022;
      (p as { x: number; y: number }).y -= p.y * 0.0022;
    }
  }

  let cx = 0;
  let cy = 0;
  for (const p of pos) {
    cx += p.x;
    cy += p.y;
  }
  cx /= Math.max(1, pos.length);
  cy /= Math.max(1, pos.length);

  let ex = 0;
  let ey = 0;
  for (const p of pos) {
    ex = Math.max(ex, Math.abs(p.x - cx));
    ey = Math.max(ey, Math.abs(p.y - cy));
  }

  const scale = Math.min(
    1.12 / Math.max(ex, 0.2),
    0.76 / Math.max(ey, 0.2),
    3.4,
  );

  return pos.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale }));
}

// ═══════════════════════════════════════════════════════════
// 3D 布局：把星群放进一个球壳，前后分层
// ═══════════════════════════════════════════════════════════

function fibonacciSphere(count: number): Vec3[] {
  if (count <= 0) return [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - ((i + 0.5) * 2) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * golden;
    return { x: Math.cos(theta) * ring, y, z: Math.sin(theta) * ring };
  });
}

function layout3d(nodes: readonly MemoryGraphNode[], _edges: readonly MemoryGraphEdge[]): Vec3[] {
  if (nodes.length === 0) return [];

  // 3D 不按种类分簇：均匀铺在球壳上，靠连线读结构。
  // 分簇会让几个方向在投影里叠成一团，反而看不出层次。
  const sphere = fibonacciSphere(nodes.length);
  // 半径从 0.36 到 0.98：有星在球心附近，也有星在球壳上，
  // 投影后才会出现“前后层次”，而不只是一圈整齐的环。
  const radii = nodes.map((node) => 0.36 + hash01(node.id, 7) * 0.62);
  const pos: Vec3[] = nodes.map((node, i) => {
    const base = sphere[i] ?? { x: 0, y: 1, z: 0 };
    const jitter = 0.09;
    const dir = normalize3({
      x: base.x + (hash01(node.id, 8) - 0.5) * jitter,
      y: base.y + (hash01(node.id, 9) - 0.5) * jitter,
      z: base.z + (hash01(node.id, 10) - 0.5) * jitter,
    });
    const radius = radii[i] ?? 0.75;
    return { x: dir.x * radius, y: dir.y * radius, z: dir.z * radius };
  });

  /**
   * 只做一件事：把挨得太近的星推开，推完再放回各自的球壳。
   *
   * ⚠️ 不能在这里加“关系弹簧”。3D 里弹簧会把星群逐渐压成一个平面
   *   （边都在缩短，而斥力只在局部起作用），最后球云变成一张薄饼。
   *   关系已经在 2D 布局和连线上表达了，3D 需要的是体积感。
   */
  const minGap = 0.16;
  for (let iter = 0; iter < 70; iter += 1) {
    let moved = false;
    for (let i = 0; i < pos.length; i += 1) {
      const a = pos[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < pos.length; j += 1) {
        const b = pos[j];
        if (b === undefined) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dy, dz);
        if (d >= minGap || d < 1e-6) continue;
        const push = ((minGap - d) / d) * 0.42;
        (a as { x: number; y: number; z: number }).x -= dx * push;
        (a as { x: number; y: number; z: number }).y -= dy * push;
        (a as { x: number; y: number; z: number }).z -= dz * push;
        (b as { x: number; y: number; z: number }).x += dx * push;
        (b as { x: number; y: number; z: number }).y += dy * push;
        (b as { x: number; y: number; z: number }).z += dz * push;
        moved = true;
      }
    }

    // 斥力只改变方向，不改变远近层次：把每颗星放回自己的球壳。
    for (let i = 0; i < pos.length; i += 1) {
      const p = pos[i];
      if (p === undefined) continue;
      const target = radii[i] ?? 0.75;
      const len = Math.hypot(p.x, p.y, p.z);
      if (len < 1e-5) continue;
      const k = target / len;
      (p as { x: number; y: number; z: number }).x *= k;
      (p as { x: number; y: number; z: number }).y *= k;
      (p as { x: number; y: number; z: number }).z *= k;
    }

    if (!moved) break;
  }

  return pos;
}

// ═══════════════════════════════════════════════════════════
// 组装
// ═══════════════════════════════════════════════════════════

function starRadius(item: MemoryItem, degree: number): number {
  const fitness = clamp01(item.fitness);
  const confidence = clamp01(item.confidence);
  const links = Math.min(degree, 6) / 6;
  return 5.5 + fitness * 5.9 + confidence * 1.5 + links * 1.8;
}

/**
 * 把服务端的关系图投影成一片星空。
 *
 * 计算量集中在加载时：最多的 200 个节点、600 条边，
 * 两次布局一共约几十万次距离计算 —— 用户不会为此等第二眼。
 */
export function buildStarMap(
  graphNodes: readonly MemoryGraphNode[],
  graphEdges: readonly MemoryGraphEdge[],
): StarMap {
  const nodesForLayout = graphNodes.slice(0, 200);
  const p2 = layout2d(nodesForLayout, graphEdges);
  const p3 = layout3d(nodesForLayout, graphEdges);

  const nodes: StarNode[] = nodesForLayout.map((node, i) => {
    const rgb = LIFECYCLE_RGB[node.lifecycle];
    return {
      id: node.id,
      item: node,
      degree: node.degree,
      p2: p2[i] ?? { x: 0, y: 0 },
      p3: p3[i] ?? { x: 0, y: 0, z: 0 },
      radius: starRadius(node, node.degree),
      color: LIFECYCLE_COLOR[node.lifecycle],
      rgb,
      phase: hash01(node.id, 21) * Math.PI * 2,
    };
  });

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));

  const edges: StarEdge[] = [];
  for (const edge of graphEdges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push({
      id: edge.id,
      a,
      b,
      type: edge.type,
      weight: clamp01(edge.weight),
      reason: edge.reason ?? null,
      curve: hash01(edge.id, 31) * 2 - 1,
    });
  }

  return { nodes, edges, index };
}

export interface EdgeLegendItem {
  readonly type: MemoryEdgeType;
  readonly count: number;
}

export function edgeLegend(edges: readonly StarEdge[]): readonly EdgeLegendItem[] {
  const counts = new Map<MemoryEdgeType, number>();
  for (const edge of edges) counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
  return EDGE_ORDER.filter((type) => (counts.get(type) ?? 0) > 0).map((type) => ({
    type,
    count: counts.get(type) ?? 0,
  }));
}