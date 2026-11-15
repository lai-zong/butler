/**
 * 专注空间背景（图片 / 视频）的本地存储。
 *
 * ★ 背景**只**进浏览器 IndexedDB，不发往服务端，也不写进应用数据目录。
 *   这样「背景可自定义」与「本地优先」不冲突。
 * ★ 图片与视频共用同一个 IndexedDB 槽位；旧版本只存了 Blob，
 *   读取时会自动识别成图片，不会因为升级而丢背景。
 * ★ 调整参数（明暗 / 模糊 / 缩放 / 填充方式 / 视频声音）放 localStorage。
 */

const DB_NAME = 'butler-focus-space';
const DB_VERSION = 1;
const ASSET_STORE = 'assets';
const BACKDROP_KEY = 'backdrop';
const SETTINGS_KEY = 'butler.focus.backdrop';

export type FocusBackdropKind = 'image' | 'video';

export interface FocusBackdropAsset {
  readonly blob: Blob;
  readonly kind: FocusBackdropKind;
  readonly name: string;
}

interface StoredBackdrop {
  readonly blob: Blob;
  readonly kind: FocusBackdropKind;
  readonly name: string;
}

export interface FocusBackdropSettings {
  /** cover = 填充并裁切；contain = 完整显示 */
  readonly fit: 'cover' | 'contain';
  /** 0–24px */
  readonly blur: number;
  /**
   * 遮罩不透明度，58–88（百分比）。
   *
   * ★ 有背景时下限 58：任何图片/视频上都要保证文字可读。
   */
  readonly dim: number;
  /** 100–140（百分比） */
  readonly scale: number;
  /** 视频背景是否播放原声；默认关闭，避免自动播放被浏览器拦截。 */
  readonly videoSound: boolean;
  /** 视频原声音量，0–100 */
  readonly videoVolume: number;
}

export const DEFAULT_BACKDROP_SETTINGS: FocusBackdropSettings = {
  fit: 'cover',
  blur: 0,
  dim: 66,
  scale: 100,
  videoSound: false,
  videoVolume: 60,
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function kindOfBlob(blob: Blob, fallbackName = ''): FocusBackdropKind {
  if (blob.type.startsWith('video/')) return 'video';
  if (blob.type.startsWith('image/')) return 'image';
  if (/\.(mp4|m4v|webm|ogv|ogg|mov)$/i.test(fallbackName)) return 'video';
  return 'image';
}

function normalizeSettings(raw: unknown): FocusBackdropSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BACKDROP_SETTINGS;
  const rec = raw as Record<string, unknown>;
  const fit = rec['fit'] === 'contain' ? 'contain' : 'cover';
  const blur = typeof rec['blur'] === 'number' ? clamp(Math.round(rec['blur']), 0, 24) : 0;
  const dim = typeof rec['dim'] === 'number' ? clamp(Math.round(rec['dim']), 58, 88) : 66;
  const scale = typeof rec['scale'] === 'number' ? clamp(Math.round(rec['scale']), 100, 140) : 100;
  const videoSound = rec['videoSound'] === true;
  const videoVolume =
    typeof rec['videoVolume'] === 'number' ? clamp(Math.round(rec['videoVolume']), 0, 100) : 60;
  return { fit, blur, dim, scale, videoSound, videoVolume };
}

export function readBackdropSettings(): FocusBackdropSettings {
  if (typeof window === 'undefined') return DEFAULT_BACKDROP_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw === null ? DEFAULT_BACKDROP_SETTINGS : normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BACKDROP_SETTINGS;
  }
}

export function writeBackdropSettings(settings: FocusBackdropSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下写不进去就只在本次打开生效。
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持本地背景存储'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地背景存储'));
    request.onblocked = () => reject(new Error('本地背景存储被其它窗口占用'));
  });
  // 打开失败不能永久缓存这个 rejected Promise，否则后续上传也永远失败。
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地存储操作失败'));
  });
}

function normalizeStored(value: unknown): StoredBackdrop | null {
  if (value instanceof Blob) {
    return { blob: value, kind: kindOfBlob(value), name: '' };
  }
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (!(rec['blob'] instanceof Blob)) return null;
  const blob = rec['blob'];
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const kind =
    rec['kind'] === 'video' || rec['kind'] === 'image'
      ? rec['kind']
      : kindOfBlob(blob, name);
  return { blob, kind, name };
}

export async function loadBackdropAsset(): Promise<FocusBackdropAsset | null> {
  const db = await openDb();
  const tx = db.transaction(ASSET_STORE, 'readonly');
  const store = tx.objectStore(ASSET_STORE);
  const value = await requestResult<unknown>(store.get(BACKDROP_KEY));
  return normalizeStored(value);
}

export async function saveBackdropAsset(asset: FocusBackdropAsset): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ASSET_STORE, 'readwrite');
  const stored: StoredBackdrop = { blob: asset.blob, kind: asset.kind, name: asset.name };
  tx.objectStore(ASSET_STORE).put(stored, BACKDROP_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('背景保存失败'));
    tx.onabort = () => reject(tx.error ?? new Error('背景保存被中断'));
  });
}

export async function clearBackdropAsset(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ASSET_STORE, 'readwrite');
  tx.objectStore(ASSET_STORE).delete(BACKDROP_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('背景删除失败'));
    tx.onabort = () => reject(tx.error ?? new Error('背景删除被中断'));
  });
}
