'use client';

/**
 * Web 界面内的悬浮桌宠
 *
 * ★ 它不是一个缩小版聊天页：
 *   桌板只有「状态 → 最近几轮 → 输入」三块，推理/工具/审查都不进来。
 *   展开时像一张贴在页面右下角的便签，收起后只剩人物本身。
 *
 * ★ 唯一发送者：
 *   同一个浏览器里只有 leader 标签页渲染桌宠、持有会话发送权；
 *   其它标签页只显示一枚很轻的“在另一个标签页”提示。
 *
 * ★ 位置只存在浏览器本地：
 *   收起不重置位置；刷新后从 localStorage 恢复并夹在视口内，
 *   拖到屏幕外不会让它永久丢在看不见的地方。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { SessionControls } from '../chat/SessionControls';
import type { ModelChoice, PickableProfile } from '../chat/ModelPicker';
import { DEFAULT_REASONING } from '../chat/sessionSettings.js';
import { errorMessage } from '../lib/api.js';
import type { ReasoningLevel, SessionSettingsPatch } from '../lib/types.js';
import type { PetMessage, PetTurn } from './petChat.js';
import {
  applyPetEvent,
  composePetText,
  fetchPetModelProfiles,
  fetchPetSession,
  fetchPetSessionSnapshot,
  foldPetTurn,
  openPetChat,
  patchPetSessionSettings,
  readPetEvents,
  recentPetMessages,
} from './petChat.js';
import { acquirePetLeadership } from './petLeader.js';
import { usePetConfig } from './usePetConfig.js';
import '../../styles/webpet.css';

const POSITION_KEY = 'butler.webpet.position';
const BOARD_HEIGHT_KEY = 'butler.webpet.boardHeight';
const DEFAULT_BOARD_HEIGHT = 360; // 540 的 2/3，长对话仍在内部滚动
const MIN_BOARD_HEIGHT = 240;
const MAX_BOARD_HEIGHT = 540;
const MAX_IMAGES = 3;
const MAX_DOCS = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOC_CHARS = 20_000;
const MOBILE_MAX_WIDTH = 760;

interface WebPetProps {
  /** 只有主界面（对话/设置/任务）才显示；控制台 surface 传 false。 */
  readonly active: boolean;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface PetImage {
  readonly id: string;
  readonly name: string;
  readonly dataUrl: string;
}

interface PetDoc {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly chars: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originX: number;
  readonly originY: number;
  moved: boolean;
}

interface ResizeState {
  readonly pointerId: number;
  readonly startY: number;
  readonly startHeight: number;
  readonly below: boolean;
}

// ── 语音识别：浏览器实现不一致，这里只声明用得到的部分 ──

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface SpeechEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function makeId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function readStoredBoardHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(BOARD_HEIGHT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(MIN_BOARD_HEIGHT, Math.min(MAX_BOARD_HEIGHT, Math.round(n)));
  } catch {
    return null;
  }
}

function readStoredPosition(): Position | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const x = rec['x'];
    const y = rec['y'];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取图片失败'));
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function WebPet({ active }: WebPetProps): JSX.Element | null {
  const { config, assets, loading: configLoading } = usePetConfig();

  const [leader, setLeader] = useState(false);
  const [leaderSettled, setLeaderSettled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [hiddenByUser, setHiddenByUser] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [boardHeight, setBoardHeight] = useState(DEFAULT_BOARD_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [imageBroken, setImageBroken] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [history, setHistory] = useState<readonly PetMessage[]>([]);
  const [turn, setTurn] = useState<PetTurn | null>(null);

  // 会话级「模型 · 思考强度」：与主对话同源，读写 /api/sessions/<petSession>。
  const [profiles, setProfiles] = useState<readonly PickableProfile[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(DEFAULT_REASONING);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<readonly PetImage[]>([]);
  const [docs, setDocs] = useState<readonly PetDoc[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const suppressClickRef = useRef(false);
  const historyLoadedRef = useRef<string | null>(null);
  const historyTouchedRef = useRef(false);
  const storedProbedRef = useRef(false);
  const settingsSavingRef = useRef(false);
  const settingsTouchedRef = useRef(false);

  // ── 唯一标签页 ─────────────────────────────────────────

  useEffect(() => acquirePetLeadership(setLeader), []);

  useEffect(() => {
    if (leader) {
      setLeaderSettled(true);
      return;
    }
    // Web Locks 的排队方不会收到回调；等一会儿再显示“另一个标签页”。
    const timer = window.setTimeout(() => setLeaderSettled(true), 900);
    return () => window.clearTimeout(timer);
  }, [leader]);

  // ── 视口与位置 ──────────────────────────────────────────

  useEffect(() => {
    const update = (): void =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  useEffect(() => {
    if (storedProbedRef.current) return;
    storedProbedRef.current = true;
    const stored = readStoredPosition();
    if (stored !== null) setPosition(stored);
    const storedHeight = readStoredBoardHeight();
    if (storedHeight !== null) setBoardHeight(storedHeight);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BOARD_HEIGHT_KEY, String(boardHeight));
    } catch {
      // 隐私模式：本次会话仍可拖动，只是不记住
    }
  }, [boardHeight]);

  const petSize = useMemo(() => {
    if (config === null) return 180;
    const source = viewport.height > 0 ? viewport.height : 900;
    const ratio = viewport.width > 0 && viewport.width <= MOBILE_MAX_WIDTH ? 0.26 : 0.42;
    const cap = Math.min(420, Math.round(source * ratio));
    return Math.max(96, Math.min(config.size, cap));
  }, [config, viewport]);

  const maxBoardHeight = useMemo(
    () => Math.max(MIN_BOARD_HEIGHT, Math.min(MAX_BOARD_HEIGHT, viewport.height - 120)),
    [viewport.height],
  );
  const effectiveBoardHeight = Math.max(
    MIN_BOARD_HEIGHT,
    Math.min(boardHeight, maxBoardHeight),
  );

  useEffect(() => {
    if (viewport.height === 0) return;
    setBoardHeight((prev) => Math.min(prev, maxBoardHeight));
  }, [maxBoardHeight, viewport.height]);

  const clampPosition = useCallback(
    (next: Position): Position => {
      const width = Math.max(viewport.width, 320);
      const height = Math.max(viewport.height, 480);
      const bottomReserve = viewport.width <= MOBILE_MAX_WIDTH ? 78 : 10;
      const maxX = Math.max(8, width - petSize - 8);
      const maxY = Math.max(8, height - petSize - bottomReserve);
      const x = Math.min(Math.max(8, Math.round(next.x)), maxX);
      const y = Math.min(Math.max(8, Math.round(next.y)), maxY);
      return x === next.x && y === next.y ? next : { x, y };
    },
    [viewport, petSize],
  );

  useEffect(() => {
    if (position === null || viewport.width === 0) return;
    const clamped = clampPosition(position);
    if (clamped !== position) setPosition(clamped);
  }, [position, viewport, clampPosition]);

  useEffect(() => {
    if (position === null || dragging) return;
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // 隐私模式：本次会话仍可拖，只是不记住
    }
  }, [position, dragging]);

  // ── 会话与历史 ─────────────────────────────────────────

  const webConfigured =
    config !== null && config.enabled && config.displayMode === 'web';

  useEffect(() => {
    if (webConfigured) return;
    setHiddenByUser(false);
    setMenu(null);
  }, [webConfigured]);

  const loadModelCatalog = useCallback(async (): Promise<void> => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const list = await fetchPetModelProfiles();
      setProfiles(list);
    } catch (err) {
      setCatalogError(errorMessage(err));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelCatalog();
  }, [loadModelCatalog]);

  useEffect(() => {
    if (!active || !webConfigured || !leader || sessionId !== null) return;
    let cancelled = false;
    setSessionError(null);
    void fetchPetSession()
      .then((id) => {
        if (!cancelled) setSessionId(id);
      })
      .catch((err) => {
        if (!cancelled) setSessionError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, webConfigured, leader, sessionId, sessionRetry]);

  useEffect(() => {
    if (!leader || sessionId === null) return;
    if (historyLoadedRef.current === sessionId) return;
    historyLoadedRef.current = sessionId;
    let cancelled = false;
    void fetchPetSessionSnapshot(sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        if (!historyTouchedRef.current) {
          setHistory(recentPetMessages(snapshot.messages));
        }
        // 用户已经手动改过设置时，不让迟到的快照把选择覆盖回去。
        if (!settingsTouchedRef.current) {
          setReasoning(snapshot.reasoning);
          setModel(snapshot.model);
        }
      })
      .catch(() => {
        if (cancelled) return;
        historyLoadedRef.current = null;
        // 历史失败不阻塞发消息；下一次拿到 session 再试。
      });
    return () => {
      cancelled = true;
    };
  }, [leader, sessionId]);

  // ── 语音 / 文本域 / 滚动 ────────────────────────────────

  useEffect(() => {
    setVoiceSupported(speechRecognitionCtor() !== null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 92)}px`;
  }, [input, open]);

  useEffect(() => {
    if (hint === null) return;
    const timer = window.setTimeout(() => setHint(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        setMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 点击桌板外的页面区域时收起桌板；模型/思考浮层是 portal，不能误关。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (widgetRef.current?.contains(target) === true) return;
      if (target.closest('.session-controls-pop') !== null) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // 右键菜单点外部 / Esc 关闭；不关桌板。
  useEffect(() => {
    if (menu === null) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  useEffect(() => {
    if (!open) return;
    const el = threadRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [open, history, turn]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recognitionRef.current?.abort();
    };
  }, []);

  // ── 发送 / 停止 ────────────────────────────────────────

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!active || !webConfigured || !leader || sendingRef.current) return;
    if (turn !== null && turn.status === 'running') return;

    const typed = input.trim();
    const pickedImages = images;
    const pickedDocs = docs;
    if (typed.length === 0 && pickedImages.length === 0 && pickedDocs.length === 0) return;

    sendingRef.current = true;
    try {
      let id = sessionId;
      if (id === null) {
        try {
          id = await fetchPetSession();
          setSessionId(id);
          setSessionError(null);
        } catch (err) {
          setSessionError(errorMessage(err));
          return;
        }
      }

      const outgoing = composePetText(
        typed,
        pickedDocs.map((doc) => ({ name: doc.name, text: doc.text })),
      );
      if (outgoing.length === 0) return;

      const display =
        typed.length > 0
          ? typed
          : pickedImages.length > 0 && pickedDocs.length > 0
            ? '（图片与文档）'
            : pickedImages.length > 0
              ? '（图片）'
              : '（文档）';

      historyTouchedRef.current = true;
      setHistory((prev) => foldPetTurn(prev, turn));

      setTurn({
        id: makeId('turn'),
        userText: display,
        outgoingText: outgoing,
        stage: null,
        narration: '',
        reply: '',
        status: 'running',
        error: null,
        startedAt: Date.now(),
      });
      setInput('');
      setImages([]);
      setDocs([]);
      setAttachError(null);
      setHint(null);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await openPetChat({
          sessionId: id,
          text: outgoing,
          images: pickedImages.map((image) => image.dataUrl),
          signal: controller.signal,
        });
        for await (const event of readPetEvents(res)) {
          if (event.kind === 'session') {
            if (event.sessionId !== id) setSessionId(event.sessionId);
            continue;
          }
          if (event.kind === 'settings') {
            // 本轮设置快照不再展示“本轮/下一轮”提示。
            continue;
          }
          setTurn((prev) => (prev === null ? prev : applyPetEvent(prev, event)));
        }
        setTurn((prev) => {
          if (prev === null || prev.status !== 'running') return prev;
          return { ...prev, status: 'done' };
        });
      } catch (err) {
        if (controller.signal.aborted) {
          setTurn((prev) => (prev === null ? prev : { ...prev, status: 'cancelled' }));
        } else {
          setTurn((prev) =>
            prev === null ? prev : { ...prev, status: 'error', error: errorMessage(err) },
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    } finally {
      sendingRef.current = false;
    }
  }, [active, webConfigured, leader, turn, input, images, docs, sessionId]);

  const stopTurn = useCallback((): void => {
    const controller = abortRef.current;
    if (controller === null) return;
    abortRef.current = null;
    controller.abort();
    setTurn((prev) =>
      prev === null || prev.status !== 'running' ? prev : { ...prev, status: 'cancelled' },
    );
    setHint('已停止这一轮；取消会写入会话事件。');
  }, []);

  // ── 会话设置：模型 · 思考强度 ──────────────────────────
  //
  // ★ 只 PATCH 这一条固定桌宠会话；pet-config 里的模型/思考是
  //   桌面 Tk 桌宠的偏好，两者互不覆盖。
  // ★ 执行中允许改：后端本轮已持有 TurnSettings 快照。

  async function patchSessionSettings(
    patch: SessionSettingsPatch,
    optimistic: () => void,
    rollback: () => void,
  ): Promise<void> {
    if (settingsSavingRef.current) return;
    let id = sessionId;
    if (id === null) {
      try {
        id = await fetchPetSession();
        setSessionId(id);
      } catch (err) {
        const message = errorMessage(err);
        setSettingsError(message);
        setHint(`设置保存失败：${message}`);
        return;
      }
    }

    settingsSavingRef.current = true;
    setSettingsSaving(true);
    setSettingsError(null);
    settingsTouchedRef.current = true;
    optimistic();

    try {
      const next = await patchPetSessionSettings(id, patch);
      setReasoning(next.reasoning);
      setModel(next.model);
      setHint('设置已保存到这条桌宠会话。');
    } catch (err) {
      rollback();
      const message = errorMessage(err);
      setSettingsError(message);
      setHint(`设置保存失败：${message}`);
    } finally {
      settingsSavingRef.current = false;
      setSettingsSaving(false);
    }
  }

  function selectChatModel(choice: ModelChoice): void {
    if (model !== null && model.profileId === choice.profileId && model.modelId === choice.modelId) {
      return;
    }
    const previous = model;
    void patchSessionSettings(
      { modelProfileId: choice.profileId, modelId: choice.modelId },
      () => setModel(choice),
      () => setModel(previous),
    );
  }

  function selectReasoning(level: ReasoningLevel): void {
    if (level === reasoning) return;
    const previous = reasoning;
    void patchSessionSettings(
      { reasoning: level },
      () => setReasoning(level),
      () => setReasoning(previous),
    );
  }

  // ── 拖动 ───────────────────────────────────────────────

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 上一次拖动留下的抑制标记只对那一次 click 有效；新的按下就清掉。
    suppressClickRef.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = clampPosition({ x: rect.left, y: rect.top });
    setPosition(origin);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 某些浏览器在 pointerdown 里拿不到 capture；拖动仍可用
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    setPosition(clampPosition({ x: drag.originX + dx, y: drag.originY + dy }));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    suppressClickRef.current = drag.moved;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已自动释放
    }
  };

  const handleAvatarClick = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setMenu(null);
    setOpen((prev) => !prev);
  };

  // ── 附件 ───────────────────────────────────────────────

  async function addDocument(file: File): Promise<void> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/attachments/extract', { method: 'POST', body: form });
    let payload: unknown = null;
    try {
      payload = (await res.json()) as unknown;
    } catch {
      payload = null;
    }
    const rec = payloadRecord(payload);
    if (!res.ok || rec['ok'] !== true || typeof rec['text'] !== 'string') {
      const message =
        typeof rec['error'] === 'string' && rec['error'].length > 0
          ? rec['error']
          : `无法读取文件（HTTP ${res.status}）`;
      throw new Error(message);
    }
    const text = rec['text'].slice(0, MAX_DOC_CHARS);
    setDocs((prev) => {
      if (prev.length >= MAX_DOCS) return prev;
      return [
        ...prev,
        { id: makeId('doc'), name: file.name, text, chars: text.length },
      ];
    });
  }

  async function handleFilesPicked(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setAttachError(null);
    let imageCount = images.length;
    let docCount = docs.length;

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        if (imageCount >= MAX_IMAGES) {
          setAttachError(`最多附加 ${MAX_IMAGES} 张图片`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachError(`图片 ${file.name} 超过 4 MiB，未加入`);
          continue;
        }
        try {
          const dataUrl = await readImageAsDataUrl(file);
          imageCount += 1;
          setImages((prev) => [
            ...prev,
            { id: makeId('img'), name: file.name, dataUrl },
          ]);
        } catch (err) {
          setAttachError(`无法读取图片 ${file.name}：${errorMessage(err)}`);
        }
        continue;
      }

      if (docCount >= MAX_DOCS) {
        setAttachError(`最多附加 ${MAX_DOCS} 份文档`);
        continue;
      }
      setExtracting(true);
      try {
        docCount += 1;
        await addDocument(file);
      } catch (err) {
        setAttachError(`无法读取 ${file.name}：${errorMessage(err)}`);
      } finally {
        setExtracting(false);
      }
    }
  }

  function removeImage(id: string): void {
    setImages((prev) => prev.filter((image) => image.id !== id));
  }

  function removeDoc(id: string): void {
    setDocs((prev) => prev.filter((doc) => doc.id !== id));
  }

  // ── 语音输入 ───────────────────────────────────────────

  function toggleVoice(): void {
    if (!voiceSupported) {
      setHint('当前浏览器不支持语音输入；可以直接用文字继续。');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setListening(false);
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (Ctor === null) {
      setVoiceSupported(false);
      setHint('当前浏览器不支持语音输入；可以直接用文字继续。');
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    const base = input.trim().length > 0 ? `${input.trim()} ` : '';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const item = event.results[i];
        if (item === undefined) continue;
        if (item.isFinal) finalText += item[0].transcript;
        else interimText += item[0].transcript;
      }
      setInput(`${base}${finalText}${interimText}`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onerror = (event) => {
      setListening(false);
      setHint(
        event.error === 'not-allowed'
          ? '麦克风权限被拒绝；可以在浏览器设置里允许后重试。'
          : '语音输入没有成功，请重试或改用文字。',
      );
    };
    recognitionRef.current = recognition;
    setListening(true);
    setHint(null);
    try {
      recognition.start();
    } catch {
      setListening(false);
      setHint('语音输入启动失败，请用文字继续。');
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendMessage();
  }

  // ── 渲染 ───────────────────────────────────────────────

  const isRunning = turn !== null && turn.status === 'running';
  const status = turn === null ? 'idle' : turn.status;
  const statusText =
    status === 'running'
      ? '正在执行'
      : status === 'done'
        ? '完成'
        : status === 'cancelled'
          ? '已停止'
          : status === 'error'
            ? '出错'
            : history.length > 0
              ? '上次对话'
              : '待命';

  const transcript = useMemo<readonly PetMessage[]>(() => {
    if (turn === null) return history;
    const list: PetMessage[] = [
      ...history,
      { role: 'user', text: turn.userText.length > 0 ? turn.userText : '（附件）' },
    ];
    const answer = turn.reply.length > 0 ? turn.reply : turn.narration;
    if (answer.length > 0) list.push({ role: 'assistant', text: answer });
    return list;
  }, [history, turn]);

  const spriteUrl = useMemo(() => {
    if (config === null) return null;
    const asset = assets.find((item) => item.id === config.sprite);
    return asset?.url ?? `/pet/${encodeURIComponent(config.sprite)}/base.png`;
  }, [assets, config]);

  const boardBelow =
    position !== null &&
    viewport.height > 0 &&
    position.y < Math.min(380, viewport.height * 0.46);

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: effectiveBoardHeight,
      below: boardBelow,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 某些浏览器无法 capture；后续 move 仍会按 pointerId 判断
    }
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = resizeRef.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = event.clientY - state.startY;
    const next = state.below
      ? state.startHeight + delta
      : state.startHeight - delta;
    setBoardHeight(
      Math.max(MIN_BOARD_HEIGHT, Math.min(maxBoardHeight, Math.round(next))),
    );
  };

  const handleResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = resizeRef.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已自动释放
    }
  };

  const boardStyle = useMemo<CSSProperties>(() => {
    const style: CSSProperties = { height: `${effectiveBoardHeight}px` };
    if (position === null || viewport.width <= MOBILE_MAX_WIDTH) return style;
    const boardWidth = Math.min(374, viewport.width - 28);
    // 默认右对齐人物；只有右边放不下时才改为左对齐。
    if (position.x + petSize - boardWidth >= 10) return style;
    return { ...style, left: '0px', right: 'auto' };
  }, [position, petSize, viewport, effectiveBoardHeight]);

  const widgetStyle = useMemo<CSSProperties | undefined>(
    () =>
      position === null
        ? { width: `${petSize}px` }
        : { left: `${position.x}px`, top: `${position.y}px`, width: `${petSize}px` },
    [position, petSize],
  );

  const widgetClass = [
    'webpet',
    position === null ? 'is-docked' : 'is-floating',
    open ? 'is-open' : '',
    dragging ? 'is-dragging' : '',
    isRunning ? 'is-running' : '',
    voiceSupported ? '' : 'is-voice-unsupported',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  if (!active) return null;
  if (configLoading || config === null) return null;
  if (!config.enabled || config.displayMode !== 'web') return null;
  if (!leader) {
    if (!leaderSettled) return null;
    return (
      <div className="webpet-muted" role="status">
        <span className="webpet-muted-dot" aria-hidden="true" />
        桌宠在另一个标签页
      </div>
    );
  }

  const canSend =
    !isRunning && (input.trim().length > 0 || images.length > 0 || docs.length > 0);

  const openFullConversation = (): void => {
    setMenu(null);
    setOpen(false);
    if (sessionId === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    url.hash = '#/chat';
    window.location.assign(url.toString());
  };

  const openSettingsPage = (): void => {
    setMenu(null);
    setOpen(false);
    window.location.hash = '#/settings';
  };

  const hidePet = (): void => {
    setMenu(null);
    setOpen(false);
    setHiddenByUser(true);
  };

  if (hiddenByUser) {
    return (
      <button
        type="button"
        className="webpet-restore"
        aria-label="显示桌宠"
        title="显示桌宠"
        onClick={() => setHiddenByUser(false)}
      >
        <span className="webpet-restore-dot" aria-hidden="true" />
        显示桌宠
      </button>
    );
  }

  return (
    <div
      className={widgetClass}
      style={widgetStyle}
      ref={widgetRef}
      onContextMenu={(event) => {
        event.preventDefault();
        // 右键只打开菜单，不把左键桌板一起打开；桌板若已展开则先收起。
        setOpen(false);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu !== null && (
        <div
          ref={menuRef}
          className="webpet-menu"
          role="menu"
          aria-label="桌宠菜单"
          style={{
            left: `${Math.max(8, Math.min(menu.x, Math.max(8, viewport.width - 176)))}px`,
            top: `${Math.max(8, Math.min(menu.y, Math.max(8, viewport.height - 124)))}px`,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="webpet-menu-item"
            disabled={sessionId === null}
            onClick={openFullConversation}
          >
            打开完整对话
          </button>
          <button
            type="button"
            role="menuitem"
            className="webpet-menu-item"
            onClick={openSettingsPage}
          >
            设置
          </button>
          <button
            type="button"
            role="menuitem"
            className="webpet-menu-item"
            onClick={hidePet}
          >
            隐藏桌宠
          </button>
        </div>
      )}

      {open && (
        <section
          className={`webpet-board${boardBelow ? ' is-below' : ''}`}
          style={boardStyle}
          role="dialog"
          aria-label="Web 桌宠对话"
          aria-modal={false}
        >
          <div
            className={`webpet-resize ${boardBelow ? 'is-bottom' : 'is-top'}`}
            role="separator"
            aria-label="拖动调整桌板高度"
            aria-orientation="horizontal"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          />
          <header className="webpet-board-head">
            <div className="webpet-head-main">
              <span className={`webpet-dot is-${status}`} aria-hidden="true" />
              <span className="webpet-status" role="status" aria-live="polite">
                {statusText}
              </span>
              {isRunning && turn !== null && (
                <span className="webpet-stage" title={turn.stage ?? '正在准备'}>
                  {turn.stage ?? '正在准备…'}
                </span>
              )}
            </div>
            <button
              type="button"
              className="webpet-icon-btn"
              aria-label="收起桌宠"
              title="收起（Esc）"
              onClick={() => setOpen(false)}
            >
              <Icon name="chevronDown" size={16} />
            </button>
          </header>

          <div className="webpet-thread" ref={threadRef}>
            {sessionError !== null && (
              <div className="webpet-error">
                <span>无法连接桌宠会话：{sessionError}</span>
                <button
                  type="button"
                  className="webpet-error-btn"
                  onClick={() => {
                    setSessionError(null);
                    setSessionRetry((n) => n + 1);
                  }}
                >
                  重试
                </button>
              </div>
            )}

            {transcript.length === 0 && turn === null && (
              <div className="webpet-empty">
                <span className="webpet-empty-mark" aria-hidden="true">
                  <Icon name="sparkle" size={16} />
                </span>
                <p className="webpet-empty-title">我在这儿。</p>
                <p className="webpet-empty-sub">
                  说一句话就行。这一轮会记进桌宠固定会话，和桌面桌宠共用。
                </p>
              </div>
            )}

            {transcript.map((message, index) => {
              const streamThis =
                turn !== null &&
                turn.status === 'running' &&
                turn.reply.length === 0 &&
                turn.narration.length > 0 &&
                index === transcript.length - 1;
              if (message.role === 'user') {
                return (
                  <div className="webpet-msg webpet-msg--user" key={`user-${index}`}>
                    {message.text}
                  </div>
                );
              }
              return (
                <div className="webpet-msg webpet-msg--bot" key={`bot-${index}`}>
                  <span className="webpet-msg-role">管家</span>
                  <div className="webpet-msg-body">
                    <Markdown text={message.text} streaming={streamThis} />
                  </div>
                </div>
              );
            })}

            {isRunning && turn !== null && turn.stage !== null && (
              <div className="webpet-stage-line" role="status" aria-live="polite">
                <span className="webpet-stage-spinner" aria-hidden="true" />
                <span>{turn.stage}</span>
              </div>
            )}

            {turn !== null && turn.status === 'error' && turn.error !== null && (
              <div className="webpet-error">{turn.error}</div>
            )}

            {turn !== null && turn.status === 'cancelled' && (
              <div className="webpet-cancel-note">
                已停止这一轮；取消会写入会话事件。
              </div>
            )}
          </div>

          <div className="webpet-composer">
            {attachError !== null && <div className="webpet-attach-error">{attachError}</div>}

            {(images.length > 0 || docs.length > 0 || extracting) && (
              <div className="webpet-attachments">
                {images.map((image) => (
                  <span className="webpet-chip" key={image.id}>
                    <img src={image.dataUrl} alt="" />
                    <span className="webpet-chip-name">{image.name}</span>
                    <button
                      type="button"
                      className="webpet-chip-x"
                      aria-label={`移除图片 ${image.name}`}
                      onClick={() => removeImage(image.id)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
                {docs.map((doc) => (
                  <span className="webpet-chip" key={doc.id}>
                    <Icon name="file" size={12} />
                    <span className="webpet-chip-name">
                      {doc.name} · {doc.chars} 字
                    </span>
                    <button
                      type="button"
                      className="webpet-chip-x"
                      aria-label={`移除文档 ${doc.name}`}
                      onClick={() => removeDoc(doc.id)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
                {extracting && <span className="webpet-chip is-muted">正在读取文件…</span>}
              </div>
            )}

            <div className="webpet-input-box">
              <textarea
                ref={textareaRef}
                className="webpet-input"
                rows={1}
                value={input}
                placeholder={isRunning ? '正在执行，先等一下…' : '和管家说点什么…'}
                aria-label="给桌宠的消息"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <div className="webpet-input-actions">
                <SessionControls
                  profiles={profiles}
                  model={model}
                  reasoning={reasoning}
                  saving={settingsSaving}
                  catalogLoading={catalogLoading}
                  catalogError={catalogError}
                  settingsError={settingsError}
                  onRefreshCatalog={() => void loadModelCatalog()}
                  onSelectModel={selectChatModel}
                  onSelectReasoning={selectReasoning}
                  onOpenSettings={() => {
                    setOpen(false);
                    window.location.hash = '#/settings';
                  }}
                  popoverClassName="webpet-session-pop"
                />
                <div className="webpet-send-group">
                  {isRunning && (
                    <button
                      type="button"
                      className="webpet-send is-stop"
                      aria-label="停止这一轮"
                      title="停止这一轮"
                      onClick={stopTurn}
                    >
                      <Icon name="stop" size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="webpet-send"
                    aria-label="发送"
                    title="发送（Enter）"
                    disabled={!canSend}
                    onClick={() => void sendMessage()}
                  >
                    <Icon name="arrowUp" size={15} />
                  </button>
                </div>
              </div>
            </div>

            <div className="webpet-tools">
              <button
                type="button"
                className="webpet-tool"
                aria-label="添加图片或文档"
                title={`添加图片或文档（最多 ${MAX_IMAGES} 图 / ${MAX_DOCS} 文档）`}
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="paperclip" size={16} />
              </button>
              <button
                type="button"
                className={`webpet-tool${listening ? ' is-recording' : ''}`}
                aria-label="语音输入"
                aria-disabled={!voiceSupported}
                title={
                  voiceSupported
                    ? listening
                      ? '停止语音输入'
                      : '语音输入'
                    : '当前浏览器不支持语音输入'
                }
                onClick={toggleVoice}
              >
                <Icon name="mic" size={16} />
              </button>
              <span className={`webpet-hint${hint !== null ? ' is-note' : ''}`} role="status">
                {hint ??
                  (extracting
                    ? '正在读取附件…'
                    : voiceSupported
                      ? 'Enter 发送 · Shift+Enter 换行'
                      : 'Enter 发送 · 当前浏览器不支持语音')}
              </span>
            </div>

            <input
              ref={fileRef}
              type="file"
              className="webpet-file-input"
              accept="image/*,.pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.json"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void handleFilesPicked(event)}
            />
          </div>
        </section>
      )}

      <button
        type="button"
        className="webpet-avatar"
        style={{ width: `${petSize}px`, height: `${petSize}px` }}
        aria-label={open ? '收起桌宠对话' : '打开桌宠对话'}
        aria-expanded={open}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={handleAvatarClick}
      >
        {spriteUrl !== null && !imageBroken ? (
          <img
            src={spriteUrl}
            alt="管家"
            draggable={false}
            onError={() => setImageBroken(true)}
          />
        ) : (
          <span className="webpet-avatar-fallback">管家</span>
        )}
        {isRunning && <span className="webpet-avatar-pulse" aria-hidden="true" />}
      </button>
    </div>
  );
}
