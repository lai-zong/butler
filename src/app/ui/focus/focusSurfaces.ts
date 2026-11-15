/**
 * 专注空间三个浮层的「玻璃」参数。
 *
 * ★ 只有设置了自定义背景时这些参数才生效：
 *   没有图片时三块窗口保持主题纸面，不牺牲可读性。
 * ★ 玻璃默认完全没有底色：只做模糊，背景原本的颜色直接透出来。
 *   「玻璃浓度」是一条可选的**中性黑纱**（默认 0），只在背景太花时加一点提升可读性。
 * ★ 「去色」默认 0，保留背景原色；「背景亮度」只调整背后的虚化画面。
 * ★ 参数只进 localStorage，与背景图片一样不上传服务端。
 */

export type FocusSurfaceId = 'chat' | 'schedule' | 'panel';

export interface FocusSurfaceStyle {
  /** 0–60（百分比）：中性黑纱浓度，0 = 绝对透明 */
  readonly opacity: number;
  /** 0–30px */
  readonly blur: number;
  /** 0–100：越高，背后的画面越接近黑白；0 = 保留原色 */
  readonly desaturate: number;
  /** 60–140（百分比）：只调整背景的虚化画面明暗 */
  readonly brightness: number;
}

export type FocusSurfaceSettings = Readonly<Record<FocusSurfaceId, FocusSurfaceStyle>>;

export const FOCUS_SURFACE_IDS: readonly FocusSurfaceId[] = ['chat', 'schedule', 'panel'];

export const DEFAULT_SURFACE_SETTINGS: FocusSurfaceSettings = {
  chat: { opacity: 0, blur: 24, desaturate: 0, brightness: 100 },
  schedule: { opacity: 0, blur: 24, desaturate: 0, brightness: 100 },
  panel: { opacity: 0, blur: 26, desaturate: 0, brightness: 100 },
};

const STORAGE_KEY = 'butler.focus.surfaces.v2';
const MIN_OPACITY = 0;
const MAX_OPACITY = 60;
const MAX_BLUR = 30;
const MIN_BRIGHTNESS = 60;
const MAX_BRIGHTNESS = 140;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normalizeStyle(raw: unknown, fallback: FocusSurfaceStyle): FocusSurfaceStyle {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const rec = raw as Record<string, unknown>;
  return {
    opacity:
      typeof rec['opacity'] === 'number'
        ? clamp(Math.round(rec['opacity']), MIN_OPACITY, MAX_OPACITY)
        : fallback.opacity,
    blur:
      typeof rec['blur'] === 'number'
        ? clamp(Math.round(rec['blur']), 0, MAX_BLUR)
        : fallback.blur,
    desaturate:
      typeof rec['desaturate'] === 'number'
        ? clamp(Math.round(rec['desaturate']), 0, 100)
        : fallback.desaturate,
    brightness:
      typeof rec['brightness'] === 'number'
        ? clamp(Math.round(rec['brightness']), MIN_BRIGHTNESS, MAX_BRIGHTNESS)
        : fallback.brightness,
  };
}

function normalize(raw: unknown): FocusSurfaceSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SURFACE_SETTINGS;
  const rec = raw as Record<string, unknown>;
  return {
    chat: normalizeStyle(rec['chat'], DEFAULT_SURFACE_SETTINGS.chat),
    schedule: normalizeStyle(rec['schedule'], DEFAULT_SURFACE_SETTINGS.schedule),
    panel: normalizeStyle(rec['panel'], DEFAULT_SURFACE_SETTINGS.panel),
  };
}

export function readSurfaceSettings(): FocusSurfaceSettings {
  if (typeof window === 'undefined') return DEFAULT_SURFACE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SURFACE_SETTINGS : normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_SURFACE_SETTINGS;
  }
}

export function writeSurfaceSettings(settings: FocusSurfaceSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式/写入失败时只在本次打开生效。
  }
}

export const SURFACE_LIMITS = {
  minOpacity: MIN_OPACITY,
  maxOpacity: MAX_OPACITY,
  maxBlur: MAX_BLUR,
  minBrightness: MIN_BRIGHTNESS,
  maxBrightness: MAX_BRIGHTNESS,
} as const;
