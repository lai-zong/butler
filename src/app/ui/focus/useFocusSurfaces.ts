'use client';

/**
 * 浮层玻璃参数的状态与持久化。
 *
 * ★ 三个浮层各自保留一组「透明度 + 模糊」；
 *   localStorage 中的键固定，刷新后仍然是用户上次的观感。
 */

import { useCallback, useState } from 'react';

import {
  DEFAULT_SURFACE_SETTINGS,
  readSurfaceSettings,
  writeSurfaceSettings,
  type FocusSurfaceId,
  type FocusSurfaceSettings,
  type FocusSurfaceStyle,
} from './focusSurfaces.js';

export interface FocusSurfacesValue {
  readonly settings: FocusSurfaceSettings;
  readonly update: (id: FocusSurfaceId, patch: Partial<FocusSurfaceStyle>) => void;
  /** 把某个浮层的当前参数同步给三个浮层。 */
  readonly applyToAll: (id: FocusSurfaceId) => void;
  readonly reset: () => void;
}

export function useFocusSurfaces(): FocusSurfacesValue {
  // 只读一次；没有存值时返回默认参数。避免先渲染默认值再跳变。
  const [settings, setSettings] = useState<FocusSurfaceSettings>(() => readSurfaceSettings());

  const update = useCallback(
    (id: FocusSurfaceId, patch: Partial<FocusSurfaceStyle>): void => {
      setSettings((prev) => {
        const next: FocusSurfaceSettings = {
          ...prev,
          [id]: { ...prev[id], ...patch },
        };
        writeSurfaceSettings(next);
        return next;
      });
    },
    [],
  );

  const applyToAll = useCallback((id: FocusSurfaceId): void => {
    setSettings((prev) => {
      const style = prev[id];
      const next: FocusSurfaceSettings = {
        chat: { ...style },
        schedule: { ...style },
        panel: { ...style },
      };
      writeSurfaceSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback((): void => {
    setSettings(DEFAULT_SURFACE_SETTINGS);
    writeSurfaceSettings(DEFAULT_SURFACE_SETTINGS);
  }, []);

  return { settings, update, applyToAll, reset };
}
