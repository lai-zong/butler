/**
 * 前台采样源测试（A10 的数据源）
 *
 * ★ 重点不是"能取到应用名"，而是**隐私边界**：
 *   只传应用名与是否有输入，**不传窗口标题**；失败就返回 null，不编造。
 */
import { describe, expect, it, vi } from 'vitest';

import { desktopActivitySource } from '../desktopSource.js';
import type { DesktopBridgePort, ForegroundWindow } from '../../desktop/port.js';

function bridgeWith(fg: ForegroundWindow | (() => Promise<ForegroundWindow>)): DesktopBridgePort {
  const foregroundWindow =
    typeof fg === 'function' ? vi.fn(fg) : vi.fn(async () => fg);
  return { foregroundWindow } as unknown as DesktopBridgePort;
}

describe('desktopActivitySource —— 正常采样', () => {
  it('★ 返回应用名与是否有输入', async () => {
    const src = desktopActivitySource(bridgeWith({ app: 'Code.exe', hadInput: true, idleMs: 1000 }));
    await expect(src.sample()).resolves.toEqual({ app: 'Code.exe', hadInput: true });
  });

  it('★★ 只产出应用名与输入状态 —— **没有窗口标题这个字段**', async () => {
    /**
     * 这是隐私边界的具体形态：`ForegroundSample` 只有 `app` / `hadInput`。
     * 桥那边也只返回这两项，标题根本没出过 Python 进程。
     */
    const src = desktopActivitySource(bridgeWith({ app: 'chrome.exe', hadInput: false }));
    const s = await src.sample();
    expect(Object.keys(s ?? {}).sort()).toEqual(['app', 'hadInput']);
  });

  it('★ 无前台窗口（app=null）→ 返回 null，不编造', async () => {
    const src = desktopActivitySource(bridgeWith({ app: null, hadInput: false }));
    await expect(src.sample()).resolves.toBeNull();
  });

  it('★ 空字符串应用名也当没有', async () => {
    const src = desktopActivitySource(bridgeWith({ app: '   ', hadInput: false }));
    await expect(src.sample()).resolves.toBeNull();
  });
});

describe('★★ 失败处理：采样失败不编造、不抛给调用方', () => {
  it('★★ 桥抛错 → 返回 null（并回调 onError）', async () => {
    const onError = vi.fn();
    const src = desktopActivitySource(
      bridgeWith(async () => {
        throw new Error('Python 桥退出');
      }),
      { onError },
    );
    await expect(src.sample()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('没传 onError 时也不抛（静默失败）', async () => {
    const src = desktopActivitySource(
      bridgeWith(async () => {
        throw new Error('x');
      }),
    );
    await expect(src.sample()).resolves.toBeNull();
  });
});
