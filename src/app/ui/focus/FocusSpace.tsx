'use client';

/**
 * 专注空间。
 *
 * ★ 默认画面只有三样东西：日期、时间、当前安排。
 *   左侧 AI、右侧日程、底部调节面板都是浮层，默认收起；
 *   打开任何一层都不会挤压中间，也不会让时间发生位移。
 * ★ 左侧 AI 不是另一套对话：它把现有对话层重新定位到左抽屉里，
 *   会话与流式状态都还是同一份（见 ButlerApp / ChatView 的 focusMode）。
 * ★ Esc 的关闭顺序固定为：底部面板 → 侧抽屉 → 退出专注。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { Icon } from '../components/Icon';
import { useNow } from '../lib/hooks.js';
import type { Theme } from '../theme/useTheme';
import type { FocusScheduleDto, ToastMessage } from '../lib/types.js';
import { FocusBottomPanel } from './FocusBottomPanel';
import { FocusDocumentDrawer } from './FocusDocumentDrawer';
import { FocusScheduleDrawer } from './FocusScheduleDrawer';
import {
  clockLabel,
  dateLabel,
  phaseLabel,
  schedulePhase,
  scheduleRangeLabel,
  untilStartLabel,
  weekdayLabel,
  formatTimer,
} from './focusFormat.js';
import { useFocusBackdrop } from './useFocusBackdrop';
import { useFocusMusic } from './useFocusMusic';
import { useFocusSchedules } from './useFocusSchedules';
import { useFocusSurfaces } from './useFocusSurfaces';
import { useFocusTimer } from './useFocusTimer';

type Notify = (text: string, tone?: ToastMessage['tone']) => void;

interface FocusSpaceProps {
  readonly leaving: boolean;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
  readonly onExit: () => void;
  readonly chatOpen: boolean;
  readonly onChatOpenChange: (open: boolean) => void;
  /** 对话里待确认的工具审批数量；有新审批时外层会把左侧抽屉打开。 */
  readonly approvalCount: number;
  readonly notify: Notify;
}

type FocusWindowId = 'chat' | 'schedule' | 'panel';

/** 宽屏允许两个窗口并排；窄屏只保留一个，避免互相盖住。 */
function maxOpenWindows(): number {
  return window.matchMedia('(min-width: 1100px)').matches ? 2 : 1;
}

export function FocusSpace({
  leaving,
  theme,
  onToggleTheme,
  onExit,
  chatOpen,
  onChatOpenChange,
  approvalCount,
  notify,
}: FocusSpaceProps): JSX.Element {
  const now = useNow(15_000);
  const schedules = useFocusSchedules();
  const backdrop = useFocusBackdrop();
  const music = useFocusMusic();
  const surfaces = useFocusSurfaces();
  const timer = useFocusTimer();

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [documentDirty, setDocumentDirty] = useState(false);
  const [reminderQueue, setReminderQueue] = useState<readonly FocusScheduleDto[]>([]);
  const [reminderBusy, setReminderBusy] = useState(false);
  const reminderKeysRef = useRef<Set<string>>(new Set());
  const lastCheckRef = useRef(Date.now());
  const scheduleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const chatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const documentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousChatOpenRef = useRef(chatOpen);
  const openSeqRef = useRef(0);
  const openedAtRef = useRef<Record<FocusWindowId, number>>({
    chat: 0,
    schedule: 0,
    panel: 0,
  });

  const current = schedules.current;
  const currentPhase = current !== null ? schedulePhase(current, now) : null;
  const startHint =
    current !== null && currentPhase === 'upcoming' ? untilStartLabel(current.startAt, now) : null;
  const hasBackdrop = backdrop.mediaUrl !== null;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 视频背景的声音：默认静音才能自动播放；用户打开开关后恢复原声。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || backdrop.mediaKind !== 'video') return;
    video.volume = Math.min(1, Math.max(0, backdrop.settings.videoVolume / 100));
    video.muted = !backdrop.settings.videoSound;
    if (backdrop.settings.videoSound) {
      void video.play().catch(() => {
        notify('浏览器阻止了背景声音，请再点一次声音开关', 'warning');
      });
    }
  }, [
    backdrop.mediaKind,
    backdrop.mediaUrl,
    backdrop.settings.videoSound,
    backdrop.settings.videoVolume,
    notify,
  ]);

  /**
   * 三个浮层的玻璃参数写到根元素上。
   *
   * ★ 左抽屉（ChatView）不在 FocusSpace 的 DOM 子树里，
   *   用根变量比把它包进另一个上下文简单，也不会为视觉参数改组件树。
   */
  useEffect(() => {
    const root = document.documentElement;
    const styles = [
      ['chat', surfaces.settings.chat],
      ['schedule', surfaces.settings.schedule],
      ['panel', surfaces.settings.panel],
    ] as const;
    for (const [id, style] of styles) {
      root.style.setProperty(`--focus-${id}-alpha`, `${(style.opacity / 100).toFixed(2)}`);
      root.style.setProperty(`--focus-${id}-blur`, `${style.blur}px`);
      root.style.setProperty(
        `--focus-${id}-saturate`,
        `${(1 - style.desaturate / 100).toFixed(2)}`,
      );
      root.style.setProperty(
        `--focus-${id}-brightness`,
        `${(style.brightness / 100).toFixed(2)}`,
      );
    }
    return () => {
      for (const [id] of styles) {
        root.style.removeProperty(`--focus-${id}-alpha`);
        root.style.removeProperty(`--focus-${id}-blur`);
        root.style.removeProperty(`--focus-${id}-saturate`);
        root.style.removeProperty(`--focus-${id}-brightness`);
      }
    };
  }, [surfaces.settings]);

  // 只有自定义背景才启用玻璃：没有图片时保留实色纸面，文字对比更稳。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('focus-has-backdrop', hasBackdrop);
    return () => root.classList.remove('focus-has-backdrop');
  }, [hasBackdrop]);

  /**
   * 三个浮层窗口：AI 对话 / 日程 / 空间调节。
   *
   * ★ 宽屏最多同时开两个；再打开第三个时，关闭另外两个中**最先打开**的那个。
   *   这正是这一轮要的规则：面板和一侧窗口共存时，点开另一侧，
   *   先让位的是更早打开的那一个。
   * ★ 窄屏放不下两个窗口，因此最多只保留一个。
   * ★ 打开顺序用单调递增的时间戳记录；对话由父层控制，外部打开（审批）
   *   也会在下面的 effect 里进入同一套顺序。
   */
  const closeWindow = useCallback(
    (id: FocusWindowId, restoreFocus = false): void => {
      openedAtRef.current[id] = 0;
      if (id === 'chat') {
        onChatOpenChange(false);
        return;
      }
      if (id === 'schedule') {
        setScheduleOpen(false);
        if (restoreFocus) scheduleTriggerRef.current?.focus();
        return;
      }
      setPanelOpen(false);
    },
    [onChatOpenChange],
  );

  const openWindow = useCallback(
    (id: FocusWindowId): void => {
      const isOpen = id === 'chat' ? chatOpen : id === 'schedule' ? scheduleOpen : panelOpen;
      if (isOpen) return;

      const openIds: FocusWindowId[] = [];
      if (chatOpen) openIds.push('chat');
      if (scheduleOpen) openIds.push('schedule');
      if (panelOpen) openIds.push('panel');
      const max = maxOpenWindows();
      const evictCount = Math.max(0, openIds.length + 1 - max);
      if (evictCount > 0) {
        openIds.sort((a, b) => openedAtRef.current[a] - openedAtRef.current[b]);
        for (const victim of openIds.slice(0, evictCount)) {
          closeWindow(victim, false);
        }
      }

      openedAtRef.current[id] = ++openSeqRef.current;
      if (id === 'chat') onChatOpenChange(true);
      else if (id === 'schedule') setScheduleOpen(true);
      else setPanelOpen(true);
    },
    [chatOpen, closeWindow, onChatOpenChange, panelOpen, scheduleOpen],
  );

  // 对话可能由外层（审批）直接打开：同步它的打开顺序，并在超过上限时让位。
  // 同时负责对话收起后的焦点归还：面板/日程还开着时，不把焦点抢回左栏。
  useEffect(() => {
    const wasOpen = previousChatOpenRef.current;
    if (chatOpen && !wasOpen) {
      if (openedAtRef.current.chat === 0) {
        openedAtRef.current.chat = ++openSeqRef.current;
      }
      const others: FocusWindowId[] = [];
      if (scheduleOpen) others.push('schedule');
      if (panelOpen) others.push('panel');
      const overflow = others.length + 1 - maxOpenWindows();
      if (overflow > 0) {
        others.sort((a, b) => openedAtRef.current[a] - openedAtRef.current[b]);
        for (const victim of others.slice(0, overflow)) {
          closeWindow(victim, false);
        }
      }
    } else if (!chatOpen && wasOpen) {
      openedAtRef.current.chat = 0;
      if (!panelOpen && !scheduleOpen) chatTriggerRef.current?.focus();
    }
    previousChatOpenRef.current = chatOpen;
  }, [chatOpen, closeWindow, panelOpen, scheduleOpen]);

  const closeSchedule = useCallback((): void => {
    closeWindow('schedule', true);
  }, [closeWindow]);

  /** 关闭文档窗口；有未保存修改时先确认。返回 false 表示用户取消了关闭。 */
  const closeDocument = useCallback(
    (restoreFocus = true): boolean => {
      if (!documentOpen) return true;
      if (
        documentDirty &&
        !window.confirm('文档里有未保存的修改，确定收起吗？')
      ) {
        return false;
      }
      setDocumentOpen(false);
      setDocumentDirty(false);
      if (restoreFocus) documentTriggerRef.current?.focus();
      return true;
    },
    [documentDirty, documentOpen],
  );

  const openDocument = useCallback((): void => {
    if (documentOpen) {
      closeDocument();
      return;
    }
    if (scheduleOpen) closeWindow('schedule', false);
    if (panelOpen) closeWindow('panel', false);
    if (window.matchMedia('(max-width: 1200px)').matches) {
      onChatOpenChange(false);
    }
    setDocumentOpen(true);
  }, [
    closeDocument,
    closeWindow,
    documentOpen,
    onChatOpenChange,
    panelOpen,
    scheduleOpen,
  ]);

  /**
   * 点击画面空白处收起所有浮层。
   *
   * ★ 只处理落在专注空间里的指针事件：左抽屉在 DOM 里是另一个 sibling，
   *   点击对话本身不会冒泡到这里；右侧日程与底部面板是子节点，用 closest 排除。
   * ★ 空白处 = 背景、时间、当前安排文字；可点击的按钮/链接/输入不触发。
   */
  const handleBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          'button, a, input, select, textarea, [role="button"], [role="switch"], [role="slider"], .focus-panel, .focus-drawer, .focus-reminder, .focus-chrome, .focus-rail, .focus-panel-anchor',
        ) !== null
      ) {
        return;
      }
      if (panelOpen) closeWindow('panel');
      if (scheduleOpen) closeWindow('schedule');
      if (documentOpen) closeDocument(false);
      if (chatOpen) closeWindow('chat');
    },
    [chatOpen, closeDocument, closeWindow, documentOpen, panelOpen, scheduleOpen],
  );

  // Esc：底部面板 → 日程 / 文档 → AI 抽屉 → 退出专注。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (panelOpen) {
        event.preventDefault();
        closeWindow('panel', true);
        return;
      }
      if (scheduleOpen) {
        event.preventDefault();
        closeWindow('schedule', true);
        return;
      }
      if (documentOpen) {
        event.preventDefault();
        closeDocument();
        return;
      }
      if (chatOpen) {
        event.preventDefault();
        closeWindow('chat');
        return;
      }
      event.preventDefault();
      onExit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatOpen, closeDocument, closeWindow, documentOpen, onExit, panelOpen, scheduleOpen]);

  // 日程提醒：只在专注空间挂载期间检查；只认「开始时间刚跨过」的那一次。
  useEffect(() => {
    const check = (): void => {
      const moment = Date.now();
      const from = lastCheckRef.current;
      lastCheckRef.current = moment;
      const due: FocusScheduleDto[] = [];
      for (const schedule of schedules.schedules) {
        if (!schedule.remind) continue;
        if (schedule.startAt <= from || schedule.startAt > moment) continue;
        const key = `${schedule.id}:${schedule.startAt}`;
        if (reminderKeysRef.current.has(key)) continue;
        reminderKeysRef.current.add(key);
        due.push(schedule);
      }
      if (due.length > 0) setReminderQueue((prev) => [...prev, ...due]);
    };
    const poll = window.setInterval(check, 15_000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [schedules.schedules]);

  // 被删除 / 改期的日程不应继续留在提醒队列里。
  useEffect(() => {
    setReminderQueue((prev) => {
      const next = prev.filter((item) =>
        schedules.schedules.some(
          (schedule) => schedule.id === item.id && schedule.startAt === item.startAt,
        ),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [schedules.schedules]);

  const reminder = useMemo(() => {
    for (const item of reminderQueue) {
      const live = schedules.schedules.find((schedule) => schedule.id === item.id);
      if (live !== undefined && live.startAt === item.startAt) return live;
    }
    return null;
  }, [reminderQueue, schedules.schedules]);

  const dismissReminder = useCallback((): void => {
    setReminderQueue((prev) => prev.slice(1));
  }, []);

  const startReminder = useCallback((): void => {
    if (reminder === null || reminderBusy) return;
    setReminderBusy(true);
    void schedules
      .setCurrent(reminder.id)
      .then(() => {
        notify('已设为当前安排', 'success');
        dismissReminder();
      })
      .catch((err: unknown) => {
        notify(err instanceof Error ? err.message : String(err), 'danger');
      })
      .finally(() => setReminderBusy(false));
  }, [dismissReminder, notify, reminder, reminderBusy, schedules]);

  const openChat = useCallback((): void => {
    if (
      documentOpen &&
      window.matchMedia('(max-width: 1200px)').matches &&
      !closeDocument()
    ) {
      return;
    }
    openWindow('chat');
  }, [closeDocument, documentOpen, openWindow]);

  const openSchedule = useCallback((): void => {
    if (documentOpen && !closeDocument(false)) return;
    openWindow('schedule');
  }, [closeDocument, documentOpen, openWindow]);

  const handlePanelOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        if (documentOpen && !closeDocument(false)) return;
        openWindow('panel');
      } else {
        closeWindow('panel', true);
      }
    },
    [closeDocument, closeWindow, documentOpen, openWindow],
  );

  const backdropStyle: CSSProperties = {
    backgroundImage:
      backdrop.mediaUrl !== null ? `url("${backdrop.mediaUrl}")` : undefined,
    backgroundSize: backdrop.settings.fit === 'cover' ? 'cover' : 'contain',
    filter: `blur(${backdrop.settings.blur}px)`,
    transform: `scale(${backdrop.settings.scale / 100})`,
  };
  const videoStyle: CSSProperties = {
    objectFit: backdrop.settings.fit === 'cover' ? 'cover' : 'contain',
    filter: `blur(${backdrop.settings.blur}px)`,
    transform: `scale(${backdrop.settings.scale / 100})`,
  };
  const veilStyle = { opacity: backdrop.settings.dim / 100 } as CSSProperties;

  return (
    <div
      className={`focus-space${leaving ? ' is-leaving' : ''}${hasBackdrop ? ' has-backdrop' : ''}`}
      role="region"
      aria-label="专注空间"
      onPointerDown={handleBackgroundPointerDown}
    >
      <div className="focus-backdrop" aria-hidden="true">
        {backdrop.mediaUrl !== null && backdrop.mediaKind === 'video' && (
          <video
            ref={videoRef}
            className="focus-bg focus-bg--video"
            src={backdrop.mediaUrl}
            style={videoStyle}
            muted={!backdrop.settings.videoSound}
            loop
            autoPlay
            playsInline
            preload="metadata"
            disablePictureInPicture
            onError={() =>
              notify('背景视频无法播放，建议使用 MP4（H.264）或 WebM 格式', 'warning')
            }
          />
        )}
        {backdrop.mediaUrl !== null && backdrop.mediaKind !== 'video' && (
          <div className="focus-bg" style={backdropStyle} />
        )}
        {backdrop.mediaUrl !== null && <div className="focus-veil" style={veilStyle} />}
        <div className="focus-wash" />
        <div className="focus-vignette" />
      </div>

      <header className="focus-chrome">
        <span className="focus-wordmark">专注空间</span>
        <button type="button" className="focus-exit" onClick={onExit} title="退出专注空间" aria-label="退出专注空间">
          <Icon name="close" size={15} />
          <span>退出</span>
        </button>
      </header>

      <div className="focus-rail focus-rail--left">
        <button
          ref={chatTriggerRef}
          type="button"
          className={`focus-rail-btn${chatOpen ? ' is-open' : ''}`}
          onClick={openChat}
          aria-label={approvalCount > 0 ? '打开 AI 对话，有工具审批待确认' : '打开 AI 对话'}
          title="AI 对话"
        >
          <span className="focus-rail-icon">
            <Icon name="chat" size={19} />
            {approvalCount > 0 && <i className="focus-rail-dot" />}
          </span>
          <span className="focus-rail-label">AI 对话</span>
          {approvalCount > 0 && <span className="focus-rail-note">待确认</span>}
        </button>
      </div>

      <main className="focus-stage">
        <div className="focus-center">
          <FocusClock />

          <section
            className={`focus-current${current === null ? ' is-empty' : ''}`}
            aria-live="polite"
            aria-label="当前安排"
          >
            <div className="focus-current-head">
              <span className="focus-current-kicker">当前安排</span>
              {current !== null && currentPhase !== null && (
                <span className={`focus-phase is-${currentPhase}`}>{phaseLabel(currentPhase)}</span>
              )}
            </div>

            {current === null ? (
              <div className="focus-current-inner">
                <p className="focus-current-empty">还没有设为当前的事。</p>
                <button type="button" className="focus-text-link" onClick={openSchedule}>
                  从日程里选一件
                  <Icon name="chevronRight" size={14} />
                </button>
              </div>
            ) : (
              <div className="focus-current-inner" key={`${current.id}:${current.updatedAt}`}>
                <h1 className="focus-current-title" title={current.title}>{current.title}</h1>
                <p className="focus-current-time">
                  {scheduleRangeLabel(current, now)}
                  {startHint !== null && <span className="focus-current-hint"> · {startHint}</span>}
                </p>
                {current.note.length > 0 && <p className="focus-current-note">{current.note}</p>}
              </div>
            )}
          </section>

          {reminder === null && !panelOpen && (timer.running || timer.finished || music.current !== null) && (
            <div className="focus-quiet-status" aria-live="off">
              {timer.running && (
                <span className="focus-quiet-item">
                  <Icon name="clock" size={13} /> 专注中 {formatTimer(timer.remainingMs)}
                </span>
              )}
              {timer.finished && (
                <span className="focus-quiet-item is-done">
                  <Icon name="checkCircle" size={13} /> 这一轮完成了
                </span>
              )}
              {music.current !== null && (
                <span className="focus-quiet-item">
                  <Icon name="music" size={13} /> {music.current.name}
                  <span className="focus-quiet-muted">{music.playing ? '播放中' : '已暂停'}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </main>

      <div className="focus-rail focus-rail--right focus-rail--stack">
        <button
          ref={scheduleTriggerRef}
          type="button"
          className={`focus-rail-btn${scheduleOpen ? ' is-open' : ''}`}
          onClick={() => {
            if (scheduleOpen) closeSchedule();
            else openSchedule();
          }}
          aria-label={`打开日程${schedules.schedules.length > 0 ? `，共 ${schedules.schedules.length} 条` : ''}`}
          title="日程"
        >
          <span className="focus-rail-icon">
            <Icon name="calendar" size={19} />
            {schedules.schedules.length > 0 && <em className="focus-rail-count">{schedules.schedules.length}</em>}
          </span>
          <span className="focus-rail-label">日程</span>
        </button>
        <button
          ref={documentTriggerRef}
          type="button"
          className={`focus-rail-btn${documentOpen ? ' is-open' : ''}`}
          onClick={openDocument}
          aria-label="打开文档"
          title="文档"
        >
          <span className="focus-rail-icon">
            <Icon name="file" size={19} />
          </span>
          <span className="focus-rail-label">文档</span>
        </button>
      </div>

      {reminder !== null && (
        <aside className="focus-reminder" role="status" aria-label="日程提醒">
          <span className="focus-reminder-mark" aria-hidden="true">
            <Icon name="bell" size={15} />
          </span>
          <div className="focus-reminder-copy">
            <strong>{reminder.title}</strong>
            <small>
              {clockLabel(reminder.startAt)} 开始
              {reminderQueue.length > 1 ? ` · 另有 ${reminderQueue.length - 1} 条` : ''}
            </small>
          </div>
          <button type="button" className="focus-text-btn" onClick={startReminder} disabled={reminderBusy}>
            开始专注
          </button>
          <button
            type="button"
            className="focus-icon-btn"
            onClick={dismissReminder}
            aria-label="关闭提醒"
            title="关闭提醒"
          >
            <Icon name="close" size={14} />
          </button>
        </aside>
      )}

      <FocusBottomPanel
        open={panelOpen}
        onOpenChange={handlePanelOpenChange}
        drawer={chatOpen ? 'left' : scheduleOpen ? 'right' : null}
        backdrop={backdrop}
        mediaUrl={backdrop.mediaUrl}
        mediaKind={backdrop.mediaKind}
        music={music}
        timer={timer}
        surfaces={surfaces}
        hasBackdrop={hasBackdrop}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

      {scheduleOpen && (
        <FocusScheduleDrawer
          schedules={schedules.schedules}
          currentId={schedules.currentId}
          loading={schedules.loading}
          error={schedules.error}
          onReload={schedules.reload}
          onClose={closeSchedule}
          onCreate={schedules.create}
          onUpdate={schedules.update}
          onRemove={schedules.remove}
          onSetCurrent={schedules.setCurrent}
          notify={notify}
        />
      )}

      {documentOpen && (
        <FocusDocumentDrawer
          notify={notify}
          onClose={() => {
            closeDocument();
          }}
          onDirtyChange={setDocumentDirty}
        />
      )}

      <audio
        ref={music.audioRef}
        src={music.current?.url}
        loop={music.loop}
        preload="metadata"
        onEnded={music.handleEnded}
        hidden
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 日期与时间
// ═══════════════════════════════════════════════════════════

function FocusClock(): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    const poll = window.setInterval(tick, 5_000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const time = clockLabel(now);
  const [hh, mm] = time.split(':');

  return (
    <div className="focus-clock-block">
      <p className="focus-date">
        <span>{dateLabel(now)}</span>
        <span className="focus-date-sep" aria-hidden="true">·</span>
        <span>{weekdayLabel(now)}</span>
      </p>
      <time className="focus-clock" dateTime={time} aria-label={`${dateLabel(now)} ${weekdayLabel(now)} ${time}`}>
        <span>{hh}</span>
        <span className="focus-clock-colon" aria-hidden="true">:</span>
        <span>{mm}</span>
      </time>
    </div>
  );
}
