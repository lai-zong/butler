'use client';

/**
 * 使用节奏上报器 —— 挂在应用外壳上，随路由切换更新页面
 *
 * ★ 上报什么：只有 `page`、`sessionId`（本次使用内的随机串）与 `active`。
 *   不含对话、任务、工具、记忆或审查内容。
 *
 * ★ 什么时候上报：
 *   · 页面可见、窗口聚焦、且应用已启动完成时；
 *   · 每约 60 秒一次心跳；
 *   · 切页立即上报（5 秒内的连续切页合并成一次，避免刷访问数）；
 *   · 页面隐藏或失焦立即停止；
 *   · 使用节奏页本身不在可统计页面里，停在那里时不打点。
 *
 * ★ `active` 由客户端判定：最近 3 分钟有指针/键盘/滚动操作 = 活跃。
 *   只是开着没动过时仍然心跳（服务端用它算“在界面前台多久”），
 *   但标记为非活跃，不计入活跃时长。
 *
 * 这个组件不渲染任何东西。
 */

import { useEffect, useRef } from 'react';

import { ApiError, fetchJson } from '../lib/api.js';
import {
  USAGE_PING_INTERVAL_MS,
  USAGE_SWITCH_COALESCE_MS,
  createUsageSessionId,
  getUsageEnabled,
  isRecentlyActive,
  sendUsagePing,
  setUsageEnabled,
  shouldRotateUsageSession,
  subscribeUsageEnabled,
} from '../lib/usage.js';
import type { UsagePageId, UsageSettingsResponse } from '../lib/types.js';

interface UsageReporterProps {
  /** 当前页面；null 表示当前页不参与统计（使用节奏页）。 */
  readonly page: UsagePageId | null;
  /** 应用是否已进入可交互状态（启动动画期间不上报）。 */
  readonly active: boolean;
}

interface UsageReporterControl {
  readonly setPage: (page: UsagePageId | null) => void;
  readonly setActive: (active: boolean) => void;
}

/** 心跳检查频率：1 秒一次只是为了能及时切页/恢复，真正打点仍按 60 秒。 */
const HEARTBEAT_TICK_MS = 1_000;

/** 两次打点的最小间隔，防止切页瞬间连续发两个心跳。 */
const MIN_PING_SPACING_MS = 2_000;

export function UsageReporter({ page, active }: UsageReporterProps): null {
  const controlRef = useRef<UsageReporterControl | null>(null);

  // ★ 只挂一次：事件监听与心跳计时器都在这里，页面/激活状态通过 control 更新。
  //   首帧的 page/active 作为初始值，之后由下面的同步 effect 驱动。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    let disposed = false;
    let appActive = active;
    let currentPage = page;
    let focused = document.hasFocus();
    let enabled = getUsageEnabled();
    /** 接口不存在时（后端尚未部署）本页寿命内不再尝试。 */
    let supported = true;
    let sessionId: string | null = null;
    let lastPingAt = 0;
    let lastPingPage: UsagePageId | null = null;
    let lastInteractionAt = Date.now();
    let sending = false;
    let trailingTimer = 0;

    const stopTrailing = (): void => {
      if (trailingTimer !== 0) {
        window.clearTimeout(trailingTimer);
        trailingTimer = 0;
      }
    };

    const engaged = (): boolean =>
      !disposed &&
      appActive &&
      supported &&
      enabled === true &&
      currentPage !== null &&
      document.visibilityState === 'visible' &&
      focused;

    const scheduleTrailing = (): void => {
      if (trailingTimer !== 0 || disposed) return;
      const wait = Math.max(80, USAGE_SWITCH_COALESCE_MS - (Date.now() - lastPingAt));
      trailingTimer = window.setTimeout(() => {
        trailingTimer = 0;
        if (disposed || !engaged()) return;
        if (sending) {
          scheduleTrailing();
          return;
        }
        if (currentPage !== lastPingPage) report('page');
      }, wait);
    };

    const report = (reason: 'page' | 'heartbeat'): void => {
      if (!engaged() || sending) return;
      const nextPage = currentPage;
      if (nextPage === null) return;
      const now = Date.now();

      if (reason === 'page') {
        if (nextPage === lastPingPage) return;
        if (now - lastPingAt < MIN_PING_SPACING_MS) {
          scheduleTrailing();
          return;
        }
      }

      if (shouldRotateUsageSession(lastPingAt, now)) {
        sessionId = createUsageSessionId();
      }

      const activeNow = isRecentlyActive(now, lastInteractionAt);
      // 先记尝试时间：即使失败也等下一个心跳再试，不在一秒一次地重试。
      lastPingAt = now;
      lastPingPage = nextPage;
      sending = true;
      void sendUsagePing(nextPage, sessionId, activeNow)
        .then((result) => {
          if (disposed) return;
          if (result === 'unsupported') {
            supported = false;
            stopTrailing();
            return;
          }
          if (result === 'disabled') {
            enabled = false;
            stopTrailing();
            setUsageEnabled(false);
            return;
          }
          // 请求期间用户又切了页：补一次，保证新页面被立刻记录。
          if (engaged() && currentPage !== lastPingPage) scheduleTrailing();
        })
        .finally(() => {
          sending = false;
        });
    };

    const requestPagePing = (): void => {
      if (!engaged()) {
        stopTrailing();
        return;
      }
      if (currentPage === lastPingPage) return;
      report('page');
    };

    const setPage = (next: UsagePageId | null): void => {
      if (next === currentPage) return;
      currentPage = next;
      if (next === null) {
        // 停在不参与统计的页面（使用节奏页）：下次回到任何页面都要重新打点，
        // 否则“同页返回”会被误判成没有切页。
        lastPingPage = null;
        stopTrailing();
        return;
      }
      // 切页本身就是一次用户操作。
      lastInteractionAt = Date.now();
      requestPagePing();
    };

    const setActive = (next: boolean): void => {
      if (next === appActive) return;
      appActive = next;
      if (!next) {
        stopTrailing();
        return;
      }
      lastInteractionAt = Date.now();
      requestPagePing();
    };

    // ── 用户操作：只更新时间戳，不读取任何输入内容 ──
    const markInteraction = (): void => {
      lastInteractionAt = Date.now();
    };

    const onFocus = (): void => {
      focused = true;
      // 切回窗口通常意味着用户回来了，算一次操作。
      markInteraction();
      requestPagePing();
    };
    const onBlur = (): void => {
      focused = false;
      stopTrailing();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        focused = document.hasFocus();
        requestPagePing();
        return;
      }
      stopTrailing();
    };

    const interactionEvents = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'touchstart',
    ] as const;
    for (const type of interactionEvents) {
      window.addEventListener(type, markInteraction, { passive: true });
    }
    window.addEventListener('scroll', markInteraction, { passive: true, capture: true });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribe = subscribeUsageEnabled((next) => {
      enabled = next;
      if (!next) {
        stopTrailing();
        return;
      }
      requestPagePing();
    });

    // 启动检查：已知开/关就立即按状态走；未知时读一次设置。
    if (enabled === true) {
      requestPagePing();
    } else if (enabled === null) {
      void (async () => {
        try {
          const settings = await fetchJson<UsageSettingsResponse>('/api/usage/settings');
          if (!disposed) setUsageEnabled(settings.enabled);
        } catch (err) {
          if (disposed) return;
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
            supported = false;
            return;
          }
          // 设置读不到不阻止记录：服务端仍可拒绝（disabled），那时会自动停。
          setUsageEnabled(true);
        }
      })();
    }

    const heartbeat = window.setInterval(() => {
      if (!engaged()) return;
      if (Date.now() - lastPingAt < USAGE_PING_INTERVAL_MS - HEARTBEAT_TICK_MS) return;
      report('heartbeat');
    }, HEARTBEAT_TICK_MS);

    controlRef.current = { setPage, setActive };

    return () => {
      disposed = true;
      controlRef.current = null;
      window.clearInterval(heartbeat);
      stopTrailing();
      unsubscribe();
      for (const type of interactionEvents) {
        window.removeEventListener(type, markInteraction);
      }
      window.removeEventListener('scroll', markInteraction, true);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // 页面与激活状态通过 controlRef 同步，故意不重新挂载监听器。
  }, []);

  useEffect(() => {
    controlRef.current?.setPage(page);
  }, [page]);

  useEffect(() => {
    controlRef.current?.setActive(active);
  }, [active]);

  return null;
}
