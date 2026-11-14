'use client';

/**
 * Web 桌宠读取同一份 pet-config，并在标签页之间同步变化。
 *
 * ★ 首次 fetch + 自定义事件：
 *   设置页保存后 `window.dispatchEvent(new CustomEvent('butler:pet-config'))`，
 *   本标签页的 WebPet 立刻显示/隐藏，不必等下一次轮询。
 *
 * ★ BroadcastChannel + localStorage：
 *   其它标签页收不到 DOM 自定义事件，所以设置页同时广播一次；
 *   不支持 BroadcastChannel 的浏览器用 storage 事件兜底。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../lib/api.js';
import type { PetAssetView, PetConfigResponse, PetConfigView } from '../lib/types.js';
import { fetchPetConfig } from './petChat.js';

/** 设置页保存启用/配置后派发的同标签页事件。 */
export const PET_CONFIG_EVENT = 'butler:pet-config';

const CHANNEL_NAME = 'butler.webpet.config';
const STORAGE_KEY = 'butler.webpet.config.rev';

export interface PetConfigState {
  readonly config: PetConfigView | null;
  readonly assets: readonly PetAssetView[];
  readonly loading: boolean;
  readonly error: string | null;
}

function asConfig(value: unknown): PetConfigView | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['enabled'] !== 'boolean') return null;
  return value as PetConfigView;
}

interface ConfigBroadcast {
  readonly type: 'config';
  readonly config: PetConfigView;
  readonly at: number;
}

function asBroadcast(value: unknown): ConfigBroadcast | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'config') return null;
  const config = asConfig(rec['config']);
  if (config === null) return null;
  return { type: 'config', config, at: typeof rec['at'] === 'number' ? rec['at'] : Date.now() };
}

function applyResponse(res: PetConfigResponse): {
  readonly config: PetConfigView;
  readonly assets: readonly PetAssetView[];
} {
  return { config: res.config, assets: res.assets };
}

/**
 * 广播一次配置变化。
 *
 * 设置页保存启用/配置后调用；WebPet 自己也会收到同一事件。
 * 不依赖返回的配置对象是否完整 —— 接收方只读 enabled / size / sprite 等字段。
 */
export function publishPetConfig(config: PetConfigView): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<PetConfigView>(PET_CONFIG_EVENT, { detail: config }));

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      const message: ConfigBroadcast = { type: 'config', config, at: Date.now() };
      channel.postMessage(message);
      channel.close();
    }
  } catch {
    // 广播失败不影响当前标签页
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // 隐私模式：只影响跨标签页同步
  }
}

export interface PetConfigHook extends PetConfigState {
  readonly reload: () => void;
}

export function usePetConfig(): PetConfigHook {
  const [state, setState] = useState<PetConfigState>({
    config: null,
    assets: [],
    loading: true,
    error: null,
  });
  const seqRef = useRef(0);

  const applyConfig = useCallback((config: PetConfigView): void => {
    setState((prev) => {
      // 旧响应/旧广播不能覆盖更新的配置（updatedAt 由服务端每次保存刷新）。
      if (prev.config !== null && config.updatedAt < prev.config.updatedAt) return prev;
      return { ...prev, config, loading: false, error: null };
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    try {
      const res = await fetchPetConfig();
      if (seq !== seqRef.current) return;
      const next = applyResponse(res);
      setState((prev) => {
        if (prev.config !== null && next.config.updatedAt < prev.config.updatedAt) {
          return { ...prev, assets: next.assets, loading: false, error: null };
        }
        return { config: next.config, assets: next.assets, loading: false, error: null };
      });
    } catch (err) {
      if (seq !== seqRef.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage(err),
      }));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      // 让仍在路上的响应失效
      seqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onCustom = (event: Event): void => {
      const config = asConfig((event as CustomEvent<unknown>).detail);
      if (config !== null) applyConfig(config);
    };
    window.addEventListener(PET_CONFIG_EVENT, onCustom);

    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.addEventListener('message', (event: MessageEvent<unknown>) => {
          const message = asBroadcast(event.data);
          if (message !== null) applyConfig(message.config);
        });
      }
    } catch {
      channel = null;
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) void load();
    };
    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener(PET_CONFIG_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
      channel?.close();
    };
  }, [applyConfig, load]);

  return { ...state, reload: () => void load() };
}
