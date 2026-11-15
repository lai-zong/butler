'use client';

/**
 * 自定义背景（图片或视频）的上传、读取与调节。
 *
 * ★ 上传动作只发生在浏览器里：先生成 object URL 立即显示，
 *   再把 Blob 写进 IndexedDB。写盘失败时背景仍然可用，
 *   只是刷新后需要重新选择 —— 界面会如实说明，不假装已保存。
 * ★ 视频默认静音播放（浏览器自动播放策略），声音开关只在用户显式操作后打开。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatFileSize } from './focusFormat.js';
import {
  clearBackdropAsset,
  loadBackdropAsset,
  readBackdropSettings,
  saveBackdropAsset,
  writeBackdropSettings,
  type FocusBackdropKind,
  type FocusBackdropSettings,
} from './focusBackdrop.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 大视频直接交给 IndexedDB；真正能否保存由浏览器可用配额决定。 */
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-m4v',
]);

export interface FocusBackdropValue {
  readonly mediaUrl: string | null;
  readonly mediaKind: FocusBackdropKind | null;
  readonly mediaName: string | null;
  readonly mediaSize: number | null;
  readonly hasBackdrop: boolean;
  readonly settings: FocusBackdropSettings;
  readonly storageNote: string | null;
  /** 大文件写入 IndexedDB 期间为 true，界面据此显示保存提示。 */
  readonly saving: boolean;
  readonly chooseMedia: (file: File) => Promise<void>;
  readonly clearMedia: () => void;
  readonly updateSettings: (patch: Partial<FocusBackdropSettings>) => void;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function kindForFile(file: File): FocusBackdropKind | null {
  if (ALLOWED_IMAGE_TYPES.has(file.type)) return 'image';
  if (ALLOWED_VIDEO_TYPES.has(file.type)) return 'video';
  const ext = extensionOf(file.name);
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'].includes(ext)) return 'video';
  return null;
}

async function ensureStorageBudget(bytes: number): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return;
    const available = quota - usage;
    if (bytes > available * 0.95) {
      throw new Error(
        `浏览器可用存储不足：需要 ${formatFileSize(bytes)}，当前只剩约 ${formatFileSize(
          Math.max(0, available),
        )}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('浏览器可用存储不足')) throw err;
    // 拿不到配额时继续尝试；真正失败会在保存阶段给出提示。
  }
}

export function useFocusBackdrop(): FocusBackdropValue {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<FocusBackdropKind | null>(null);
  const [mediaName, setMediaName] = useState<string | null>(null);
  const [mediaSize, setMediaSize] = useState<number | null>(null);
  const [settings, setSettings] = useState<FocusBackdropSettings>(() => readBackdropSettings());
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mediaUrlRef = useRef<string | null>(null);

  const replaceMedia = useCallback(
    (
      next: string | null,
      kind: FocusBackdropKind | null,
      name: string | null,
      size: number | null,
    ): void => {
      if (mediaUrlRef.current !== null) URL.revokeObjectURL(mediaUrlRef.current);
      mediaUrlRef.current = next;
      setMediaUrl(next);
      setMediaKind(kind);
      setMediaName(name);
      setMediaSize(size);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (mediaUrlRef.current !== null) URL.revokeObjectURL(mediaUrlRef.current);
      mediaUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadBackdropAsset()
      .then((asset) => {
        if (cancelled) return;
        if (asset === null) {
          setStorageNote(null);
          return;
        }
        replaceMedia(
          URL.createObjectURL(asset.blob),
          asset.kind,
          asset.name || null,
          asset.blob.size,
        );
        setStorageNote(null);
      })
      .catch(() => {
        // 没有 IndexedDB 或读取失败：不阻断专注空间，只是没有自定义背景。
        if (!cancelled) setStorageNote('当前浏览器无法读取本地背景');
      });
    return () => {
      cancelled = true;
    };
  }, [replaceMedia]);

  const chooseMedia = useCallback(
    async (file: File): Promise<void> => {
      const kind = kindForFile(file);
      if (kind === null) {
        throw new Error('请选择 JPG / PNG / WebP 图片，或 MP4 / WebM 视频');
      }
      if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
        throw new Error('图片不能超过 20 MB');
      }
      if (kind === 'video' && file.size > MAX_VIDEO_BYTES) {
        throw new Error('视频不能超过 4 GB');
      }
      setSaving(true);
      try {
        await ensureStorageBudget(file.size);
        replaceMedia(URL.createObjectURL(file), kind, file.name, file.size);
        setStorageNote(null);
        try {
          await saveBackdropAsset({ blob: file, kind, name: file.name });
        } catch {
          setStorageNote('背景只在本次打开有效：本地存储不可用或空间不足');
        }
      } finally {
        setSaving(false);
      }
    },
    [replaceMedia],
  );

  const clearMedia = useCallback((): void => {
    replaceMedia(null, null, null, null);
    setStorageNote(null);
    void clearBackdropAsset().catch(() => {
      setStorageNote('背景已从当前画面移除，但本地缓存清理失败');
    });
  }, [replaceMedia]);

  const updateSettings = useCallback((patch: Partial<FocusBackdropSettings>): void => {
    setSettings((prev) => {
      const next: FocusBackdropSettings = {
        fit: patch.fit ?? prev.fit,
        blur: patch.blur ?? prev.blur,
        dim: patch.dim ?? prev.dim,
        scale: patch.scale ?? prev.scale,
        videoSound: patch.videoSound ?? prev.videoSound,
        videoVolume: patch.videoVolume ?? prev.videoVolume,
      };
      writeBackdropSettings(next);
      return next;
    });
  }, []);

  return {
    mediaUrl,
    mediaKind,
    mediaName,
    mediaSize,
    hasBackdrop: mediaUrl !== null,
    settings,
    storageNote,
    saving,
    chooseMedia,
    clearMedia,
    updateSettings,
  };
}
