'use client';

/**
 * 记忆星图 —— 渲染层
 *
 * ★ 为什么是 canvas，而不是一堆绝对定位的 div：
 *   3D 旋转时每颗星的位置每帧都在变。用 DOM 更新 200 个 transform
 *   会把主线程让给样式重算；canvas 只画一次像素。
 *   可访问性由视图层的隐藏列表 + 方向键负责，渲染层只管好看。
 *
 * ★ 球体是**预渲染的精灵图**：同一生命周期的星共用一张 128px 贴图，
 *   每帧只做一次 drawImage。径向渐变每帧重建会在 200 颗星时明显掉帧。
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import type { MemoryLifecycle } from '../lib/types.js';
import {
  EDGE_META,
  LIFECYCLE_RGB,
  easeOutCubic,
  matchesQuery,
  rgba,
  type MapMode,
  type StarEdge,
  type StarNode,
} from './starMap.js';

export interface MemoryCanvasHandle {
  zoomBy(factor: number): void;
  resetView(): void;
  /** 清掉 2D 手动摆放，回到自动星座布局。 */
  resetLayout(): void;
}

export interface MemoryCanvasProps {
  readonly nodes: readonly StarNode[];
  readonly edges: readonly StarEdge[];
  readonly mode: MapMode;
  readonly selectedId: string | null;
  readonly filter: 'all' | MemoryLifecycle;
  readonly query: string;
  readonly focusNonce: number;
  readonly autoRotate: boolean;
  readonly panelOpen: boolean;
  /** 文本模式：只画星空底，不画球体与关系线；同时停止指针交互。 */
  readonly backdropOnly: boolean;
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** 第一次手动拖动球体 / 恢复自动布局时通知视图层。 */
  readonly onManualLayoutChange: (active: boolean) => void;
}

interface ViewState {
  yaw: number;
  pitch: number;
  targetYaw: number;
  targetPitch: number;
  zoom: number;
  targetZoom: number;
  panX: number;
  panY: number;
  targetPanX: number;
  targetPanY: number;
  inset: number;
  perspMix: number;
  autoPauseUntil: number;
  /** 当前帧的 2D 投影参数：把屏幕坐标反算回归一化坐标。 */
  centerX: number;
  centerY: number;
  scale: number;
}

type DragKind = 'pan' | 'rotate' | 'node';

interface DragState {
  readonly active: boolean;
  moved: boolean;
  readonly kind: DragKind;
  readonly nodeId: string | null;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
}

interface ScreenPoint {
  readonly node: StarNode;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly z: number;
  readonly alpha: number;
}

interface Twinkler {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly alpha: number;
  readonly phase: number;
  readonly speed: number;
  readonly tint: string;
}

interface Starfield {
  readonly base: HTMLCanvasElement | null;
  readonly twinklers: readonly Twinkler[];
}

interface Meteor {
  readonly startedAt: number;
  readonly x0: number;
  readonly y0: number;
  readonly vx: number;
  readonly vy: number;
  readonly life: number;
}

interface EdgeBatch {
  readonly type: StarEdge['type'];
  readonly alpha: number;
  readonly width: number;
  readonly dashed: boolean;
  readonly path: Path2D;
}

const TAU = Math.PI * 2;
const SPRITE_SIZE = 128;
const SPRITE_CORE = 26;
const STAR_TINTS = ['#dfe9ff', '#c9fff1', '#ffe8c7', '#d7d3ff'];
/** 星图整体向右让一点：左侧留给标题与图例，避免星体压住文字。 */
const MAP_SHIFT_X = 26;

const spriteCache = new Map<MemoryLifecycle, HTMLCanvasElement>();

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function shortestAngle(delta: number): number {
  let d = delta % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): readonly [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 一颗星的身体：辉光 + 受光面 + 暗面 + 边缘反光 + 高光。 */
function getSprite(lifecycle: MemoryLifecycle): HTMLCanvasElement | null {
  const cached = spriteCache.get(lifecycle);
  if (cached !== undefined) return cached;

  const sprite = document.createElement('canvas');
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;
  const ctx = sprite.getContext('2d');
  if (ctx === null) return null;

  const rgb = LIFECYCLE_RGB[lifecycle];
  const cx = SPRITE_SIZE / 2;
  const cy = SPRITE_SIZE / 2;
  const light = mix(rgb, [255, 255, 255], 0.68);
  const mid = mix(rgb, [255, 255, 255], 0.16);
  const dark = mix(rgb, [5, 12, 15], 0.62);

  // 外层大气：让球体看起来“发光”，而不是贴了一个圆。
  const halo = ctx.createRadialGradient(cx, cy, SPRITE_CORE * 0.5, cx, cy, SPRITE_SIZE / 2);
  halo.addColorStop(0, rgba(rgb, 0.32));
  halo.addColorStop(0.34, rgba(rgb, 0.12));
  halo.addColorStop(0.68, rgba(rgb, 0.035));
  halo.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // 星体：光从左上打来。
  const body = ctx.createRadialGradient(
    cx - SPRITE_CORE * 0.36,
    cy - SPRITE_CORE * 0.4,
    SPRITE_CORE * 0.08,
    cx,
    cy,
    SPRITE_CORE,
  );
  body.addColorStop(0, rgba(light, 1));
  body.addColorStop(0.28, rgba(mid, 1));
  body.addColorStop(0.62, rgba(rgb, 1));
  body.addColorStop(0.88, rgba(dark, 1));
  body.addColorStop(1, rgba(dark, 1));
  ctx.beginPath();
  ctx.arc(cx, cy, SPRITE_CORE, 0, TAU);
  ctx.fillStyle = body;
  ctx.fill();

  // 边缘反光：一条极细的亮边，让轮廓从深色背景里浮出来。
  ctx.beginPath();
  ctx.arc(cx, cy, SPRITE_CORE - 1, 0, TAU);
  ctx.strokeStyle = rgba(light, 0.42);
  ctx.lineWidth = 0.9;
  ctx.stroke();

  // 高光。
  const spec = ctx.createRadialGradient(
    cx - SPRITE_CORE * 0.34,
    cy - SPRITE_CORE * 0.38,
    0,
    cx - SPRITE_CORE * 0.34,
    cy - SPRITE_CORE * 0.38,
    SPRITE_CORE * 0.52,
  );
  spec.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
  spec.addColorStop(0.42, 'rgba(255, 255, 255, 0.12)');
  spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(cx - SPRITE_CORE * 0.34, cy - SPRITE_CORE * 0.38, SPRITE_CORE * 0.52, 0, TAU);
  ctx.fill();

  // 暗面的一点点环境反光，避免球体“死黑”。
  const bounce = ctx.createRadialGradient(
    cx + SPRITE_CORE * 0.34,
    cy + SPRITE_CORE * 0.44,
    0,
    cx + SPRITE_CORE * 0.34,
    cy + SPRITE_CORE * 0.44,
    SPRITE_CORE * 0.7,
  );
  bounce.addColorStop(0, rgba(rgb, 0.24));
  bounce.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = bounce;
  ctx.beginPath();
  ctx.arc(cx + SPRITE_CORE * 0.34, cy + SPRITE_CORE * 0.44, SPRITE_CORE * 0.7, 0, TAU);
  ctx.fill();

  spriteCache.set(lifecycle, sprite);
  return sprite;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStarfield(width: number, height: number, dpr: number): Starfield {
  const random = mulberry32(20261029);
  const base = document.createElement('canvas');
  base.width = Math.max(1, Math.round(width * dpr));
  base.height = Math.max(1, Math.round(height * dpr));
  const ctx = base.getContext('2d');
  if (ctx === null) return { base: null, twinklers: [] };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 极淡的星云尘：给纯黑底一点空气感。
  const blobs: readonly { x: number; y: number; r: number; rgb: readonly [number, number, number] }[] = [
    { x: width * 0.66, y: height * 0.26, r: Math.min(width, height) * 0.42, rgb: [71, 132, 156] },
    { x: width * 0.2, y: height * 0.74, r: Math.min(width, height) * 0.38, rgb: [106, 86, 152] },
    { x: width * 0.84, y: height * 0.82, r: Math.min(width, height) * 0.3, rgb: [54, 116, 99] },
  ];
  for (const blob of blobs) {
    const grad = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.r);
    grad.addColorStop(0, rgba(blob.rgb, 0.055));
    grad.addColorStop(0.35, rgba(blob.rgb, 0.028));
    grad.addColorStop(0.7, rgba(blob.rgb, 0.01));
    grad.addColorStop(1, rgba(blob.rgb, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  const count = Math.round(clamp((width * height) / 3400, 170, 460));
  for (let i = 0; i < count; i += 1) {
    const x = random() * width;
    const y = random() * height;
    const radius = random() ** 2.2 * 1.15 + 0.16;
    const alpha = 0.06 + random() ** 1.7 * 0.52;
    const tint = STAR_TINTS[Math.floor(random() * STAR_TINTS.length)] ?? '#dfe9ff';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
  }

  // 少量“亮星”带十字辉光，避免星点均匀得像噪点。
  for (let i = 0; i < 5; i += 1) {
    const x = random() * width;
    const y = random() * height;
    const r = 13 + random() * 12;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(232, 250, 255, 0.4)');
    grad.addColorStop(0.2, 'rgba(172, 226, 236, 0.12)');
    grad.addColorStop(1, 'rgba(172, 226, 236, 0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(214, 246, 255, 0.1)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.8, y);
    ctx.lineTo(x + r * 0.8, y);
    ctx.moveTo(x, y - r * 0.8);
    ctx.lineTo(x, y + r * 0.8);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const twinklers: Twinkler[] = Array.from({ length: 26 }, () => ({
    x: random() * width,
    y: random() * height,
    r: 0.6 + random() * 0.9,
    alpha: 0.35 + random() * 0.5,
    phase: random() * TAU,
    speed: 0.5 + random() * 1.4,
    tint: STAR_TINTS[Math.floor(random() * STAR_TINTS.length)] ?? '#dfe9ff',
  }));

  return { base, twinklers };
}

export const MemoryCanvas = forwardRef<MemoryCanvasHandle, MemoryCanvasProps>(function MemoryCanvas(
  props,
  ref,
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const propsRef = useRef(props);
  propsRef.current = props;

  const sizeRef = useRef({ w: 0, h: 0 });
  const starsRef = useRef<Starfield>({ base: null, twinklers: [] });
  const screenRef = useRef<readonly ScreenPoint[]>([]);
  const hoverIdRef = useRef<string | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** 2D 手动摆放的归一化坐标（只影响 2D；切去 3D 再回来仍保留）。 */
  const manual2dRef = useRef(new Map<string, { x: number; y: number }>());
  const manualActiveRef = useRef(false);
  const onManualLayoutChangeRef = useRef(props.onManualLayoutChange);
  onManualLayoutChangeRef.current = props.onManualLayoutChange;
  const reduceRef = useRef(false);
  const meteorRef = useRef<Meteor | null>(null);
  const nextMeteorRef = useRef(0);
  const focusReqRef = useRef<{ x: number; y: number } | null>(null);

  const viewRef = useRef<ViewState>({
    yaw: 0.5,
    pitch: -0.18,
    targetYaw: 0.5,
    targetPitch: -0.18,
    zoom: 1,
    targetZoom: 1,
    panX: 0,
    panY: 0,
    targetPanX: 0,
    targetPanY: 0,
    inset: 0,
    perspMix: 1,
    autoPauseUntil: 0,
    centerX: 0,
    centerY: 0,
    scale: 1,
  });

  const posRef = useRef<{ cur: Float32Array; target: Float32Array; born: number }>({
    cur: new Float32Array(0),
    target: new Float32Array(0),
    born: 0,
  });

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of props.edges) {
      const a = props.nodes[edge.a];
      const b = props.nodes[edge.b];
      if (a === undefined || b === undefined) continue;
      const setA = map.get(a.id) ?? new Set<string>();
      setA.add(b.id);
      map.set(a.id, setA);
      const setB = map.get(b.id) ?? new Set<string>();
      setB.add(a.id);
      map.set(b.id, setB);
    }
    return map;
  }, [props.nodes, props.edges]);
  const adjacencyRef = useRef<ReadonlyMap<string, ReadonlySet<string>>>(adjacency);
  adjacencyRef.current = adjacency;

  // ── 数据变化：重算补间目标 ──
  useEffect(() => {
    const state = posRef.current;
    const count = props.nodes.length;
    const target = new Float32Array(count * 3);
    const manual = manual2dRef.current;

    if (manual.size > 0) {
      const ids = new Set(props.nodes.map((node) => node.id));
      for (const id of [...manual.keys()]) {
        if (!ids.has(id)) manual.delete(id);
      }
      if (manual.size === 0 && manualActiveRef.current) {
        manualActiveRef.current = false;
        onManualLayoutChangeRef.current(false);
      }
    }

    props.nodes.forEach((node, i) => {
      let p: { x: number; y: number; z: number };
      if (props.mode === '3d') {
        p = node.p3;
      } else {
        const moved = manual.get(node.id);
        p = moved !== undefined ? { x: moved.x, y: moved.y, z: 0 } : { x: node.p2.x, y: node.p2.y, z: 0 };
      }
      target[i * 3] = p.x;
      target[i * 3 + 1] = p.y;
      target[i * 3 + 2] = p.z;
    });
    if (state.cur.length !== count * 3) {
      state.cur = new Float32Array(count * 3);
      state.born = performance.now();
    }
    state.target = target;
  }, [props.nodes, props.mode]);

  // ── 模式切换：镜头回到一个适应该模式的位置 ──
  useEffect(() => {
    const view = viewRef.current;
    view.targetZoom = 1;
    view.targetPanX = 0;
    view.targetPanY = 0;
    if (props.mode === '3d') {
      view.targetYaw = view.yaw + shortestAngle(0.5 - view.yaw);
      view.targetPitch = -0.18;
      view.autoPauseUntil = performance.now() + 900;
    } else {
      view.targetYaw = 0;
      view.targetPitch = 0;
    }
  }, [props.mode]);

  // ── 从外部跳进来 / 点击“定位”：把一颗星带到视野中心 ──
  useEffect(() => {
    if (props.focusNonce <= 0 || props.selectedId === null) return;
    const node = props.nodes.find((n) => n.id === props.selectedId);
    if (node === undefined) return;
    const view = viewRef.current;
    if (props.mode === '3d') {
      const horizontal = Math.hypot(node.p3.x, node.p3.z);
      view.targetYaw = Math.atan2(node.p3.x, -node.p3.z);
      view.targetPitch = clamp(Math.atan2(-node.p3.y, horizontal), -1.15, 1.15);
      view.targetZoom = Math.max(view.targetZoom, 1.02);
      view.autoPauseUntil = performance.now() + 1200;
    } else {
      focusReqRef.current = manual2dRef.current.get(node.id) ?? node.p2;
    }
  }, [props.focusNonce, props.selectedId, props.mode, props.nodes]);

  useImperativeHandle(
    ref,
    () => ({
      zoomBy(factor: number): void {
        const view = viewRef.current;
        view.targetZoom = clamp(view.targetZoom * factor, 0.55, 2.8);
      },
      resetView(): void {
        const view = viewRef.current;
        view.targetZoom = 1;
        view.targetPanX = 0;
        view.targetPanY = 0;
        view.autoPauseUntil = performance.now() + 1200;
        if (propsRef.current.mode === '3d') {
          view.targetYaw = view.yaw + shortestAngle(0.5 - view.yaw);
          view.targetPitch = -0.18;
        } else {
          view.targetYaw = 0;
          view.targetPitch = 0;
        }
      },
      resetLayout(): void {
        manual2dRef.current.clear();
        if (manualActiveRef.current) {
          manualActiveRef.current = false;
          onManualLayoutChangeRef.current(false);
        }
        const current = propsRef.current;
        const state = posRef.current;
        current.nodes.forEach((node, i) => {
          const offset = i * 3;
          if (offset + 2 >= state.target.length) return;
          if (current.mode === '3d') {
            state.target[offset] = node.p3.x;
            state.target[offset + 1] = node.p3.y;
            state.target[offset + 2] = node.p3.z;
          } else {
            state.target[offset] = node.p2.x;
            state.target[offset + 1] = node.p2.y;
            state.target[offset + 2] = 0;
          }
        });
      },
    }),
    [],
  );

  // ── prefers-reduced-motion ──
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => {
      reduceRef.current = mql.matches;
    };
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  // ── 渲染循环 ──
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    let raf = 0;
    let last = performance.now();
    let alive = true;
    let visible = true;

    const resize = (): void => {
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: width, h: height };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      starsRef.current = buildStarfield(width, height, dpr);
      // 画布尺寸变了，之前缓存的指针位置不再可靠。
      pointerRef.current = null;
      if (hoverIdRef.current !== null) {
        hoverIdRef.current = null;
        setHoverId(null);
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const intersection = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 },
    );
    intersection.observe(wrap);

    const draw = (now: number, dt: number): void => {
      const { w, h } = sizeRef.current;
      if (!alive || !visible || w <= 2 || h <= 2) return;
      if (document.visibilityState === 'hidden') return;

      const p = propsRef.current;
      const view = viewRef.current;
      const state = posRef.current;
      const reduce = reduceRef.current;
      const smooth = (current: number, target: number, rate: number): number =>
        reduce ? target : current + (target - current) * (1 - Math.exp(-dt * rate));

      // 画布是透明的，但每帧必须先清掉上一帧的星体 ——
      // 否则旋转与位置补间会留下彗星尾巴。
      ctx.clearRect(0, 0, w, h);

      // ── 镜头 ──
      const autoActive =
        p.mode === '3d' &&
        p.autoRotate &&
        p.selectedId === null &&
        dragRef.current === null &&
        now > view.autoPauseUntil;
      if (autoActive) {
        view.yaw += dt * 0.07;
        view.targetYaw = view.yaw;
      } else {
        view.yaw = smooth(view.yaw, view.yaw + shortestAngle(view.targetYaw - view.yaw), 6.5);
      }
      view.pitch = smooth(view.pitch, view.targetPitch, 6.5);
      view.zoom = smooth(view.zoom, view.targetZoom, 8);
      view.panX = smooth(view.panX, view.targetPanX, 10);
      view.panY = smooth(view.panY, view.targetPanY, 10);
      view.perspMix = smooth(view.perspMix, p.mode === '3d' ? 1 : 0, 5.5);
      view.inset = smooth(view.inset, p.panelOpen ? Math.min(408, w * 0.45) : 0, 6);

      if (focusReqRef.current !== null && p.mode === '2d') {
        const target = focusReqRef.current;
        focusReqRef.current = null;
        const targetInset = p.panelOpen ? Math.min(408, w * 0.45) : 0;
        const focusScale =
          Math.max(
            90,
            Math.min(Math.min(w, h) * 0.46, (w - targetInset - 72) / 2.25),
          ) * view.zoom;
        view.targetPanX = -target.x * focusScale - MAP_SHIFT_X;
        view.targetPanY = -target.y * focusScale;
      }

      // ── 位置补间：2D ↔ 3D、数据刷新都靠它过渡 ──
      const count = Math.min(state.cur.length, state.target.length) / 3;
      const morph = reduce ? 1 : 1 - Math.exp(-dt * 4.2);
      for (let i = 0; i < count * 3; i += 1) {
        const from = state.cur[i] ?? 0;
        const to = state.target[i] ?? 0;
        state.cur[i] = from + (to - from) * morph;
      }

      // ── 星空底色 ──
      const pad = 26;
      const parX = clamp(view.panX * 0.015 + view.yaw * 9, -pad, pad);
      const parY = clamp(view.panY * 0.015 + view.pitch * 9, -pad, pad);
      const field = starsRef.current;
      if (field.base !== null) {
        ctx.drawImage(field.base, -pad + parX, -pad + parY, w + pad * 2, h + pad * 2);
      }
      for (const star of field.twinklers) {
        const twinkle = reduce
          ? 1
          : 0.5 + 0.5 * Math.sin(now * 0.0011 * star.speed + star.phase);
        ctx.globalAlpha = star.alpha * (0.35 + 0.65 * twinkle);
        ctx.fillStyle = star.tint;
        ctx.beginPath();
        ctx.arc(star.x + parX, star.y + parY, star.r, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ── 流星：低频，一次只留一条 ──
      if (!reduce) {
        if (meteorRef.current === null && now > nextMeteorRef.current) {
          meteorRef.current = {
            startedAt: now,
            x0: w * (0.58 + Math.random() * 0.36),
            y0: h * (0.03 + Math.random() * 0.22),
            vx: -(0.25 + Math.random() * 0.22) * w,
            vy: (0.16 + Math.random() * 0.16) * h,
            life: 900 + Math.random() * 500,
          };
        }
        const meteor = meteorRef.current;
        if (meteor !== null) {
          const t = (now - meteor.startedAt) / meteor.life;
          if (t >= 1) {
            meteorRef.current = null;
            nextMeteorRef.current = now + 7000 + Math.random() * 11000;
          } else {
            const hx = meteor.x0 + meteor.vx * t;
            const hy = meteor.y0 + meteor.vy * t;
            const tx = hx - meteor.vx * 0.11;
            const ty = hy - meteor.vy * 0.11;
            const grad = ctx.createLinearGradient(hx, hy, tx, ty);
            grad.addColorStop(0, 'rgba(231, 250, 255, 0.85)');
            grad.addColorStop(0.35, 'rgba(168, 232, 238, 0.3)');
            grad.addColorStop(1, 'rgba(168, 232, 238, 0)');
            ctx.globalAlpha = Math.sin(Math.PI * Math.min(1, t * 1.25)) * 0.9;
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(hx, hy);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      // 文本模式只保留星空底：星图仍挂载，但不再画节点与连线。
      if (p.backdropOnly) {
        pointerRef.current = null;
        if (hoverIdRef.current !== null) {
          hoverIdRef.current = null;
          setHoverId(null);
        }
        const tip = tipRef.current;
        if (tip !== null) tip.style.opacity = '0';
        ctx.globalAlpha = 1;
        return;
      }

      // ── 投影 ──
      const centerX = w / 2 - view.inset / 2 + MAP_SHIFT_X;
      const centerY = h * 0.54;
      // 侧栏打开时把它让出来的宽度也算进缩放：
      // 小屏上星图会收一点，而不是被侧栏压住一半。
      const fitScale = (w - view.inset - 72) / 2.25;
      const baseScale =
        Math.max(90, Math.min(Math.min(w, h) * 0.46, fitScale)) * view.zoom;
      // 指针拖拽球体时要把屏幕位移反算回归一化坐标，先把当前帧的参数留住。
      view.centerX = centerX;
      view.centerY = centerY;
      view.scale = baseScale;
      const cosY = Math.cos(view.yaw);
      const sinY = Math.sin(view.yaw);
      const cosX = Math.cos(view.pitch);
      const sinX = Math.sin(view.pitch);
      const project = (
        x: number,
        y: number,
        z: number,
      ): { x: number; y: number; z: number; persp: number } => {
        const rx = x * cosY + z * sinY;
        const rz0 = -x * sinY + z * cosY;
        const ry = y * cosX - rz0 * sinX;
        const rz = y * sinX + rz0 * cosX;
        const persp = 1 + ((1 / (1 + rz * 0.26)) - 1) * view.perspMix;
        return {
          x: centerX + rx * baseScale * persp + view.panX,
          y: centerY + ry * baseScale * persp + view.panY,
          z: rz,
          persp,
        };
      };

      // 3D 星云的轮廓：一条极淡的参考环，给球壳一个边界，
      // 但不画旋转的大圆 —— 侧视时会退化成一条突兀的直线。
      if (view.perspMix > 0.03) {
        ctx.save();
        ctx.globalAlpha = 0.16 * view.perspMix;
        ctx.strokeStyle = 'rgba(127, 224, 195, 0.5)';
        ctx.lineWidth = 0.7;
        ctx.setLineDash([1.5, 9]);
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseScale * 0.985, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      // ── 把星体投影到屏幕 ──
      const drag = dragRef.current;
      const draggingNodeId =
        drag !== null && drag.kind === 'node' && drag.moved ? drag.nodeId : null;
      // 拖动中的星优先成为焦点：正在摆放它，就先看它和谁相连。
      const focus = draggingNodeId ?? p.selectedId ?? hoverIdRef.current;
      const related = focus === null ? undefined : adjacencyRef.current.get(focus);
      const query = p.query.trim();
      const birthAge = now - state.born;
      const zoomRadius = Math.pow(view.zoom, 0.6);
      const points: ScreenPoint[] = [];
      const byId = new Map<string, ScreenPoint>();

      for (let i = 0; i < p.nodes.length; i += 1) {
        const node = p.nodes[i];
        if (node === undefined) continue;
        const x = state.cur[i * 3] ?? 0;
        const y = state.cur[i * 3 + 1] ?? 0;
        const z = state.cur[i * 3 + 2] ?? 0;
        const pr = project(x, y, z);

        const birth = reduce ? 1 : easeOutCubic(clamp01((birthAge - i * 14) / 640));
        const depthFade =
          1 - clamp01((pr.z + 0.35) / 1.6) * 0.45 * view.perspMix;
        let visibleAlpha = 1;
        const isSelected = p.selectedId === node.id;
        const isDragging = draggingNodeId === node.id;
        if (!isSelected && !isDragging && p.filter !== 'all' && node.item.lifecycle !== p.filter) {
          visibleAlpha *= 0.12;
        }
        if (!isSelected && !isDragging && query.length > 0 && !matchesQuery(node.item, query)) {
          visibleAlpha *= 0.12;
        }
        if (focus !== null) {
          if (node.id !== focus && !(related?.has(node.id) ?? false)) {
            // 悬停只是“指一下”，别把其余星群压暗到看不见；
            // 只有真正选中、侧栏打开时才收拢注意力。
            visibleAlpha *= p.selectedId !== null ? 0.3 : 0.72;
          }
        }

        // 拖拽中的星不参与“呼吸”位移，保证它严格跟着指针走。
        const driftX =
          reduce || draggingNodeId === node.id
            ? 0
            : Math.sin(now * 0.00043 + node.phase) * 1.3;
        const driftY =
          reduce || draggingNodeId === node.id
            ? 0
            : Math.cos(now * 0.00037 + node.phase * 1.6) * 1.1;
        const radius = Math.max(0.8, node.radius * pr.persp * zoomRadius * birth);

        const point: ScreenPoint = {
          node,
          x: pr.x + driftX,
          y: pr.y + driftY,
          r: radius,
          z: pr.z,
          alpha: visibleAlpha * depthFade * birth,
        };
        points.push(point);
        byId.set(node.id, point);
      }
      screenRef.current = points;

      // 星群会自己旋转 —— 鼠标不动时，指针下面的星也会变。
      // 每帧重新做一次命中测试，悬浮标签才不会粘在已经转走的星上。
      const pointer = pointerRef.current;
      if (pointer !== null && dragRef.current === null) {
        let best: string | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const point of points) {
          const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
          if (distance <= Math.max(14, point.r * 1.7) && distance < bestDistance) {
            bestDistance = distance;
            best = point.node.id;
          }
        }
        if (best !== hoverIdRef.current) {
          hoverIdRef.current = best;
          setHoverId(best);
        }
      }

      // ── 关系线：远→近。选中时只让与选中星相连的边说话 ──
      const edgeDraws: { edge: StarEdge; pa: ScreenPoint; pb: ScreenPoint; z: number }[] = [];
      for (const edge of p.edges) {
        const a = p.nodes[edge.a];
        const b = p.nodes[edge.b];
        if (a === undefined || b === undefined) continue;
        const pa = byId.get(a.id);
        const pb = byId.get(b.id);
        if (pa === undefined || pb === undefined) continue;
        edgeDraws.push({ edge, pa, pb, z: (pa.z + pb.z) / 2 });
      }
      edgeDraws.sort((u, v) => v.z - u.z);

      // 边一多，整张图会变成一团发光的毛线。
      // 密度越高，单根线越淡；选中时再由焦点把该亮的那几根提回来。
      const densityFade = clamp(1 - Math.max(0, edgeDraws.length - 48) / 520, 0.34, 1);
      const edgeBatches = new Map<string, EdgeBatch>();

      for (const item of edgeDraws) {
        const { edge, pa, pb } = item;
        const a = pa.node;
        const b = pb.node;
        const meta = EDGE_META[edge.type];
        let alpha = (0.17 + edge.weight * 0.38) * densityFade;

        if (
          p.filter !== 'all' &&
          a.id !== p.selectedId &&
          b.id !== p.selectedId &&
          (a.item.lifecycle !== p.filter || b.item.lifecycle !== p.filter)
        ) {
          alpha *= 0.14;
        }
        if (query.length > 0) {
          const hitA = matchesQuery(a.item, query);
          const hitB = matchesQuery(b.item, query);
          if (!hitA && !hitB) alpha *= 0.1;
          else if (!hitA || !hitB) alpha *= 0.45;
        }

        let onFocus = false;
        if (focus !== null) {
          const touches = a.id === focus || b.id === focus;
          const between =
            (related?.has(a.id) ?? false) && (related?.has(b.id) ?? false);
          onFocus = touches;
          if (touches) alpha *= 2.3;
          else if (between) alpha *= 1.05;
          else alpha *= p.selectedId !== null ? 0.15 : 0.5;
        }
        alpha *= 1 - clamp01((item.z + 0.35) / 1.6) * 0.4 * view.perspMix;
        alpha = Math.min(alpha, 0.86);
        if (alpha < 0.012) continue;

        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const length = Math.hypot(dx, dy) || 1;
        const bend = edge.curve * Math.min(18, length * 0.11);
        let cxp = (pa.x + pb.x) / 2 + (-dy / length) * bend;
        let cyp = (pa.y + pb.y) / 2 + (dx / length) * bend;

        // 3D 里让关系线贴着球壳走，而不是穿过球心：
        // 弧线读起来像星座，直线会变成一团交叉的弦。
        if (view.perspMix > 0.01) {
          const a3 = pa.node.p3;
          const b3 = pb.node.p3;
          const mx = (a3.x + b3.x) / 2;
          const my = (a3.y + b3.y) / 2;
          const mz = (a3.z + b3.z) / 2;
          const midLen = Math.hypot(mx, my, mz);
          if (midLen > 0.06) {
            const avgRadius =
              (Math.hypot(a3.x, a3.y, a3.z) + Math.hypot(b3.x, b3.y, b3.z)) / 2;
            const bulge = avgRadius * 0.97;
            const control = project(
              (mx / midLen) * bulge,
              (my / midLen) * bulge,
              (mz / midLen) * bulge,
            );
            // 直接拿球面上的中点当控制点：弧线轻微外扩，不会绕出球体。
            cxp += (control.x - cxp) * view.perspMix;
            cyp += (control.y - cyp) * view.perspMix;
          }
        }

        const baseWidth = 0.65 + edge.weight * 0.95;

        if (onFocus) {
          ctx.save();
          ctx.strokeStyle = rgba(meta.rgb, alpha * 0.24);
          ctx.lineWidth = baseWidth * 5;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.quadraticCurveTo(cxp, cyp, pb.x, pb.y);
          ctx.stroke();
          ctx.restore();
        }

        // 关系线按“颜色 / 透明度 / 宽度”分桶，同一桶只 stroke 一次。
        // 88 颗星时这里有 600+ 条边；逐条 stroke 的调用开销比像素本身还贵。
        const alphaKey = Math.round(alpha * 12) / 12;
        const widthKey = Math.round(baseWidth * (onFocus ? 2 : 1) * 4) / 4;
        const batchKey = `${edge.type}|${alphaKey}|${widthKey}|${meta.dashed ? 1 : 0}`;
        let batch = edgeBatches.get(batchKey);
        if (batch === undefined) {
          batch = {
            type: edge.type,
            alpha: alphaKey,
            width: widthKey,
            dashed: meta.dashed,
            path: new Path2D(),
          };
          edgeBatches.set(batchKey, batch);
        }
        batch.path.moveTo(pa.x, pa.y);
        batch.path.quadraticCurveTo(cxp, cyp, pb.x, pb.y);
      }

      for (const batch of edgeBatches.values()) {
        ctx.strokeStyle = rgba(EDGE_META[batch.type].rgb, batch.alpha);
        ctx.lineWidth = batch.width;
        if (batch.dashed) {
          ctx.save();
          ctx.setLineDash([2.5, 4.5]);
          ctx.lineDashOffset = -now * 0.008;
          ctx.stroke(batch.path);
          ctx.restore();
        } else {
          ctx.stroke(batch.path);
        }
      }

      // ── 选中星的外场 ──
      const selected = p.selectedId === null ? undefined : byId.get(p.selectedId);
      if (selected !== undefined) {
        const pulse = reduce ? 0.6 : 0.5 + 0.5 * Math.sin(now * 0.0026);
        const aura = ctx.createRadialGradient(
          selected.x,
          selected.y,
          selected.r * 0.6,
          selected.x,
          selected.y,
          selected.r * 5.6,
        );
        aura.addColorStop(0, rgba(selected.node.rgb, 0.2 + pulse * 0.06));
        aura.addColorStop(0.42, rgba(selected.node.rgb, 0.07));
        aura.addColorStop(1, rgba(selected.node.rgb, 0));
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(selected.x, selected.y, selected.r * 5.6, 0, TAU);
        ctx.fill();
      }

      // ── 星体：远→近 ──
      const ordered = [...points].sort((u, v) => v.z - u.z);
      for (const point of ordered) {
        if (point.alpha <= 0.02) continue;
        const node = point.node;
        ctx.globalAlpha = point.alpha;

        const sprite = getSprite(node.item.lifecycle);
        const size = Math.max(4, point.r * (SPRITE_SIZE / SPRITE_CORE));
        if (sprite !== null) {
          ctx.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size);
        } else {
          ctx.fillStyle = node.color;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r, 0, TAU);
          ctx.fill();
        }

        if (node.item.memClass === 'global_constraint') {
          ctx.strokeStyle = rgba(node.rgb, 0.34);
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 2.4, 0, TAU);
          ctx.stroke();
        }

        if (node.item.lifecycle === 'candidate') {
          ctx.save();
          ctx.setLineDash([1.4, 4.4]);
          ctx.lineDashOffset = -now * 0.012;
          ctx.strokeStyle = rgba(node.rgb, 0.58);
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 4.6, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }

        if (hoverIdRef.current === node.id && p.selectedId !== node.id) {
          ctx.strokeStyle = 'rgba(230, 248, 255, 0.62)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 5.4, 0, TAU);
          ctx.stroke();
        }

        if (p.selectedId === node.id) {
          const pulse = reduce ? 0.7 : 0.5 + 0.5 * Math.sin(now * 0.0026);
          ctx.strokeStyle = rgba(node.rgb, 0.82);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 7.6, 0, TAU);
          ctx.stroke();

          const start = reduce ? 0 : now * 0.0006;
          ctx.strokeStyle = rgba(node.rgb, 0.42 + pulse * 0.26);
          ctx.lineWidth = 1.7;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 11.6, start, start + 0.85);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 11.6, start + Math.PI, start + Math.PI + 0.85);
          ctx.stroke();
        }

        // 正在被拖动的球：白圈 + 虚线圈，明确“它跟着你的手”。
        if (draggingNodeId === node.id) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 6.4, 0, TAU);
          ctx.stroke();

          ctx.save();
          ctx.setLineDash([2, 4]);
          ctx.lineDashOffset = -now * 0.02;
          ctx.strokeStyle = rgba(node.rgb, 0.7);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r + 11, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // ── 悬浮标签只显示“元信息”，内容留给侧栏 ──
      const tip = tipRef.current;
      if (tip !== null) {
        const hovered = hoverIdRef.current === null ? undefined : byId.get(hoverIdRef.current);
        if (hovered !== undefined && hovered.alpha > 0.25) {
          const tx = clamp(hovered.x + 20, 14, Math.max(14, w - 218));
          const ty = clamp(hovered.y - 16, 68, Math.max(68, h - 84));
          tip.style.opacity = '1';
          tip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        } else {
          tip.style.opacity = '0';
        }
      }
    };

    const tick = (now: number): void => {
      if (!alive) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      draw(now, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      intersection.disconnect();
    };
  }, []);

  // ── 滚轮缩放（必须非 passive 才能阻止页面级滚动） ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const view = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0014);
      view.targetZoom = clamp(view.targetZoom * factor, 0.55, 2.8);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, []);

  const hitTest = (clientX: number, clientY: number): string | null => {
    const wrap = wrapRef.current;
    if (wrap === null) return null;
    const rect = wrap.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of screenRef.current) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= Math.max(14, point.r * 1.7) && distance < bestDistance) {
        bestDistance = distance;
        best = point.node.id;
      }
    }
    return best;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const wrap = wrapRef.current;
    if (wrap === null) return;
    wrap.setPointerCapture(event.pointerId);

    const rect = wrap.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const mode = propsRef.current.mode;
    const hit = mode === '2d' ? hitTest(event.clientX, event.clientY) : null;

    let kind: DragKind = mode === '3d' ? 'rotate' : 'pan';
    let nodeId: string | null = null;
    let offsetX = 0;
    let offsetY = 0;

    if (hit !== null) {
      const point = screenRef.current.find((p) => p.node.id === hit);
      if (point !== undefined) {
        kind = 'node';
        nodeId = hit;
        offsetX = localX - point.x;
        offsetY = localY - point.y;
        // 抓住球时冻结镜头，避免还在缓动的焦点把球从指针下面拽走。
        const view = viewRef.current;
        view.targetPanX = view.panX;
        view.targetPanY = view.panY;
        view.targetZoom = view.zoom;
        view.targetYaw = view.yaw;
        view.targetPitch = view.pitch;
      }
    }

    dragRef.current = {
      active: true,
      moved: false,
      kind,
      nodeId,
      offsetX,
      offsetY,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    setDragging(true);
    setHoverId(null);
    hoverIdRef.current = null;
    pointerRef.current = null;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag !== null && drag.active) {
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) {
        drag.moved = true;
      }
      if (drag.moved) {
        const view = viewRef.current;
        if (drag.kind === 'node' && drag.nodeId !== null) {
          const nodeId = drag.nodeId;
          const wrap = wrapRef.current;
          if (wrap !== null) {
            const rect = wrap.getBoundingClientRect();
            const localX = event.clientX - rect.left;
            const localY = event.clientY - rect.top;
            const { w, h } = sizeRef.current;
            const scale = view.scale;
            if (scale > 1) {
              // 自由拖动，但不让球被拖进侧栏或画布外找不回来。
              const maxX = Math.max(40, w - view.inset - 14);
              const maxY = Math.max(40, h - 14);
              const screenX = clamp(localX - drag.offsetX, 14, maxX);
              const screenY = clamp(localY - drag.offsetY, 14, maxY);
              const nx = (screenX - view.centerX - view.panX) / scale;
              const ny = (screenY - view.centerY - view.panY) / scale;
              const index = propsRef.current.nodes.findIndex((node) => node.id === nodeId);
              if (index >= 0) {
                const state = posRef.current;
                const offset = index * 3;
                if (offset + 2 < state.target.length) {
                  state.target[offset] = nx;
                  state.target[offset + 1] = ny;
                  state.target[offset + 2] = 0;
                }
                if (offset + 2 < state.cur.length) {
                  // 直接跟手，不走补间；松手后位置就留在那里。
                  state.cur[offset] = nx;
                  state.cur[offset + 1] = ny;
                  state.cur[offset + 2] = 0;
                }
                manual2dRef.current.set(nodeId, { x: nx, y: ny });
                if (!manualActiveRef.current) {
                  manualActiveRef.current = true;
                  onManualLayoutChangeRef.current(true);
                }
              }
            }
          }
        } else if (drag.kind === 'rotate') {
          view.targetYaw += dx * 0.0075;
          view.targetPitch = clamp(view.targetPitch + dy * 0.006, -1.15, 1.15);
        } else {
          view.panX += dx;
          view.panY += dy;
          view.targetPanX = view.panX;
          view.targetPanY = view.panY;
        }
        if (hoverIdRef.current !== null) {
          hoverIdRef.current = null;
          setHoverId(null);
        }
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }

    const wrap = wrapRef.current;
    if (wrap !== null) {
      const rect = wrap.getBoundingClientRect();
      pointerRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    }

    const hit = hitTest(event.clientX, event.clientY);
    if (hit !== hoverIdRef.current) {
      hoverIdRef.current = hit;
      setHoverId(hit);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    const wrap = wrapRef.current;
    if (wrap !== null && wrap.hasPointerCapture(event.pointerId)) {
      wrap.releasePointerCapture(event.pointerId);
    }
    if (cancelled || drag === null) return;
    if (drag.moved) {
      const wrap2 = wrapRef.current;
      if (wrap2 !== null) {
        const rect = wrap2.getBoundingClientRect();
        pointerRef.current = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
      }
      return;
    }
    const hit = hitTest(event.clientX, event.clientY);
    if (hit !== null) propsRef.current.onSelect(hit);
    else propsRef.current.onClearSelection();
  };

  const hoveredNode = hoverId === null ? null : props.nodes.find((n) => n.id === hoverId) ?? null;
  const nodeHover = !props.backdropOnly && props.mode === '2d' && hoverId !== null;

  return (
    <div
      ref={wrapRef}
      className={`mm-canvas-wrap${dragging ? ' is-dragging' : ''}${
        nodeHover ? ' is-node-hover' : ''
      }${props.backdropOnly ? ' is-backdrop' : ''}`}
      role="group"
      tabIndex={props.backdropOnly ? -1 : props.nodes.length > 0 ? 0 : -1}
      aria-hidden={props.backdropOnly ? true : undefined}
      aria-label={`记忆星图${props.mode === '2d' ? '：可拖动球体调整位置' : ''}；方向键切换记忆，回车查看详情`}
      aria-controls="memory-detail-panel"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endDrag(event, false)}
      onPointerCancel={(event) => endDrag(event, true)}
      onPointerLeave={() => {
        pointerRef.current = null;
        if (dragRef.current !== null) return;
        if (hoverIdRef.current !== null) {
          hoverIdRef.current = null;
          setHoverId(null);
        }
      }}
      onDoubleClick={() => {
        const view = viewRef.current;
        view.targetZoom = 1;
        view.targetPanX = 0;
        view.targetPanY = 0;
        if (propsRef.current.mode === '3d') {
          view.targetYaw = view.yaw + shortestAngle(0.5 - view.yaw);
          view.targetPitch = -0.18;
        } else {
          view.targetYaw = 0;
          view.targetPitch = 0;
        }
      }}
      onKeyDown={props.onKeyDown}
    >
      <canvas ref={canvasRef} className="mm-canvas" aria-hidden="true" />
      <div ref={tipRef} className="mm-tip" aria-hidden="true">
        {hoveredNode !== null && (
          <>
            <span
              className="mm-tip-orb"
              style={{ background: hoveredNode.color, boxShadow: `0 0 12px ${hoveredNode.color}` }}
            />
            <span className="mm-tip-body">
              <b>
                {hoveredNode.item.lifecycleLabel} · {hoveredNode.item.kindLabel}
              </b>
              <i>
                {hoveredNode.degree} 条关系 · 适应度 {Math.round(hoveredNode.item.fitness * 100)}%
              </i>
            </span>
            <span className="mm-tip-go">查看</span>
          </>
        )}
      </div>
    </div>
  );
});
