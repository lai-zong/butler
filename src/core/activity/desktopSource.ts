/**
 * 前台窗口采样源（A10 的数据源实现）
 *
 * ★ 之前 `ActivitySourcePort` **没有任何实现** —— 采样能力有、数据源没有，
 *   等于空转。这个文件补上最后一块。
 *
 * ⚠️ 隐私边界（不是"顺手多传一点"，是刻意限制）：
 *
 *   | 采集 | 不采集 |
 *   |---|---|
 *   | 应用名（`Code.exe`）| **窗口标题**（常含文档名 / 网页标题 / 邮件主题）|
 *   | 是否有输入（由空闲时长推出）| 具体按了什么键 |
 *
 *   这条与 `observe.ts` 里记录的 `boundaries` 字段一致：
 *   `windowTitle: false` / `keystrokes: false`。
 *   桥那边也只返回应用名，**标题根本没出过 Python 进程**。
 *
 * ★ 失败即返回 null（不重试、不编造）：
 *   采样是"有机会就看一眼"，看得到就记、看不到就算，
 *   **编一个应用名比没有数据糟得多**。
 */

import type { ActivitySourcePort, ForegroundSample } from './observe.js';
import type { DesktopBridgePort } from '../desktop/port.js';

export interface DesktopActivitySourceOptions {
  /** 桥不可用/抛错时的回调（默认静默 —— 采样失败不该打扰用户）*/
  readonly onError?: (err: unknown) => void;
}

/**
 * 用桌面桥采样前台窗口。
 *
 * ⚠️ 调用方**必须先确认用户已同意**（`observe.ts` 的 `sampleOnce` 已经在
 *    读窗口之前检查了同意开关）。这里不做二次检查，避免"两处判断不一致"。
 */
export function desktopActivitySource(
  bridge: DesktopBridgePort,
  opts?: DesktopActivitySourceOptions,
): ActivitySourcePort {
  return {
    async sample(): Promise<ForegroundSample | null> {
      try {
        const fg = await bridge.foregroundWindow();
        if (fg.app === null || fg.app.trim().length === 0) return null;
        return { app: fg.app, hadInput: fg.hadInput };
      } catch (err) {
        opts?.onError?.(err);
        // 采样失败 = 这一轮没有数据，不是错误状态
        return null;
      }
    },
  };
}
