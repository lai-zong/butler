/**
 * 推理流编排 —— 把模型分片、增量翻译、事件流串起来
 *
 * 设计依据：状态可视化
 *
 * ★ 本模块让 `thought.delta` / `thought.done` 事件**活起来**。
 *   这两个事件在类型里定义了但从未被发出（审查发现的死事件）。
 *
 * ★ 三条纪律：
 *   ① **不阻塞** —— 翻译慢不能让推理流卡住
 *   ② **事件可审计** —— 每个分片落事件（但要合并，见下）
 *   ③ **可取消** —— 用户点"停止"要真的停
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { ModelStreamChunk, ModelStreamPort, StreamCall } from '../ports/stream.js';
import { IncrementalTranslator, OrderBuffer, looksEnglish } from './translate.js';
import type { StreamPartKind } from './types.js';

/** 分片聚合落事件的窗口（毫秒）。
 *
 * ⚠️ 为什么聚合：字符级流式意味着每秒可能几十个分片。
 *    每个分片落一条事件会让事件流爆炸（且 checkpoint 扫描变慢）。
 *    方案要求"字符级流式"是**渲染**要求，不是审计要求 ——
 *    审计需要的是"这段思考的内容与时长"，不是逐字符。
 */
export const EVENT_FLUSH_MS = 400;

/** 单次推理流最多落多少条 thought.delta（兜底）。 */
export const MAX_DELTA_EVENTS = 200;

export interface StreamRunOptions {
  readonly port: ModelStreamPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly taskId: string;
  readonly call: StreamCall;
  /** 翻译端口（不给则不翻译） */
  readonly translatorPort?: import('./translate.js').TranslationPort;
  /** 每次分片/译文更新时回调（供界面渲染） */
  readonly onUpdate: (state: ReasoningViewState) => void;
  /** 是否翻译思考（默认：有翻译端口且内容是英文） */
  readonly translateReasoning?: boolean;
  /** 是否落事件（默认 true） */
  readonly emitEvents?: boolean;
}

/** 给界面渲染用的完整状态。 */
export interface ReasoningViewState {
  /** 思考原文（累计） */
  readonly reasoning: string;
  /** 思考译文（累计，可能滞后于原文） */
  readonly reasoningTranslated: string;
  /** 正式回答（累计） */
  readonly answer: string;
  /** 当前在写的是哪一段 */
  readonly current: StreamPartKind;
  /** 工具调用（分片拼接后的） */
  readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly args: string }[];
  /** 是否已结束 */
  readonly done: boolean;
  /** 首字延迟（毫秒）—— 流式体验的关键指标 */
  readonly firstChunkMs: number | null;
  /** 译文是否落后于原文（界面可显示"翻译中"） */
  readonly translationBehind: boolean;
}

export interface StreamRunResult {
  readonly reasoning: string;
  readonly reasoningTranslated: string;
  readonly answer: string;
  readonly finishReason: 'stop' | 'length' | 'toolCalls' | 'error';
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly chunks: number;
  readonly firstChunkMs: number;
  readonly durationMs: number;
  readonly translation: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
    readonly firstTranslationMs: number | null;
  } | null;
  readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly args: string }[];
}

/**
 * 跑一次推理流。
 *
 * ★ 增量翻译在这里接入：每收到 reasoning 分片就喂给翻译器，
 *   译文就绪即回调更新界面 —— **中文与英文同步增长**。
 */
export async function runReasoningStream(opts: StreamRunOptions): Promise<StreamRunResult> {
  const startedAt = opts.clock.now();
  const emitEvents = opts.emitEvents !== false;

  let reasoning = '';
  let reasoningTranslated = '';
  let answer = '';
  let current: StreamPartKind = 'reasoning';
  let done = false;
  let firstChunkMs: number | null = null;
  let chunks = 0;

  const toolCalls = new Map<string, { name: string; args: string }>();

  // ── 译文保序缓冲 ──
  const order = new OrderBuffer<string>();
  const translationQueue: string[] = [];

  let translationStats: StreamRunResult['translation'] = null;

  // ── 事件聚合 ──
  let deltaBuffer = '';
  let bufferedKind: StreamPartKind = 'reasoning';
  let lastFlushAt = startedAt;
  let deltaEvents = 0;
  let truncated = false;

  const state = (): ReasoningViewState => ({
    reasoning,
    reasoningTranslated,
    answer,
    current,
    toolCalls: [...toolCalls.entries()].map(([callId, v]) => ({
      callId,
      name: v.name,
      args: v.args,
    })),
    done,
    firstChunkMs,
    translationBehind:
      opts.translatorPort !== undefined &&
      reasoning.length > 0 &&
      reasoningTranslated.length < reasoning.length,
  });

  const flushDelta = (force = false): void => {
    if (!emitEvents) return;
    const now = opts.clock.now();
    const due = force || now - lastFlushAt >= EVENT_FLUSH_MS;
    if (!due || deltaBuffer.length === 0) return;

    if (deltaEvents >= MAX_DELTA_EVENTS) {
      if (!truncated) {
        truncated = true;
        opts.log.append({
          type: 'thought.delta',
          actor: 'butler',
          payload: {
            taskId: opts.taskId,
            truncated: true,
            note: `分片事件已达上限 ${MAX_DELTA_EVENTS} 条，后续内容不再逐条落事件（完整内容在 thought.done 里）`,
          },
          createdAt: now,
        });
      }
      deltaBuffer = '';
      lastFlushAt = now;
      return;
    }

    opts.log.append({
      type: 'thought.delta',
      actor: 'butler',
      payload: {
        taskId: opts.taskId,
        kind: bufferedKind,
        delta: deltaBuffer,
        accumulatedLength: bufferedKind === 'reasoning' ? reasoning.length : answer.length,
        // 聚合窗口时长 —— 让审计看得出"落事件被合并过"
        windowMs: now - lastFlushAt,
      },
      createdAt: now,
    });
    deltaEvents += 1;
    deltaBuffer = '';
    lastFlushAt = now;
  };

  // ── 增量翻译器 ──
  const translator =
    opts.translatorPort !== undefined && opts.translateReasoning !== false
      ? new IncrementalTranslator({
          port: opts.translatorPort,
          clock: opts.clock,
          shouldTranslate: looksEnglish,
          onTranslated: ({ source: _s, translated, index }) => {
            // 保序后追加 —— 乱序到达也不会让中文错序
            for (const piece of order.push(index, translated)) {
              reasoningTranslated += piece;
              translationQueue.push(piece);
            }
            opts.onUpdate(state());
          },
        })
      : null;

  try {
    for await (const chunk of opts.port.stream(opts.call)) {
      if (firstChunkMs === null) firstChunkMs = opts.clock.now() - startedAt;
      chunks += 1;

      switch (chunk.kind) {
        case 'reasoning': {
          reasoning += chunk.delta;
          current = 'reasoning';
          // ★ 边收边译 —— 这是"增量"的落点
          translator?.feed(chunk.delta);
          if (bufferedKind !== 'reasoning') {
            flushDelta(true);
            bufferedKind = 'reasoning';
          }
          deltaBuffer += chunk.delta;
          flushDelta();
          opts.onUpdate(state());
          break;
        }

        case 'text': {
          answer += chunk.delta;
          current = 'text';
          if (bufferedKind !== 'text') {
            flushDelta(true);
            bufferedKind = 'text';
          }
          deltaBuffer += chunk.delta;
          flushDelta();
          opts.onUpdate(state());
          break;
        }

        case 'toolCall': {
          const prev = toolCalls.get(chunk.callId) ?? { name: '', args: '' };
          toolCalls.set(chunk.callId, {
            name: chunk.name.length > 0 ? chunk.name : prev.name,
            args: prev.args + chunk.argsDelta,
          });
          opts.onUpdate(state());
          break;
        }

        case 'done': {
          done = true;
          flushDelta(true);
          break;
        }
      }
    }
  } catch (err) {
    // ⚠️ 流本身报错时也要收尾：落 done 事件、把已生成内容交出去 ——
    //    明确"流式中断：断点续传或重生成该段，**不丢已生成内容**"
    done = true;
    flushDelta(true);
    const message = err instanceof Error ? err.message : String(err);
    if (emitEvents) {
      opts.log.append({
        type: 'thought.done',
        actor: 'butler',
        payload: {
          taskId: opts.taskId,
          interrupted: true,
          error: message,
          reasoningLength: reasoning.length,
          answerLength: answer.length,
          note: '流式中断，已生成内容保留',
        },
        createdAt: opts.clock.now(),
      });
    }
    opts.onUpdate(state());
    throw Object.assign(err instanceof Error ? err : new Error(message), {
      partial: { reasoning, answer },
    });
  }

  // ── 收尾：把残余的不成句内容也译掉 ──
  if (translator) {
    translationStats = await translator.done();
    // done() 之后可能还有最后一批译文回调
    for (const piece of order.drainAll()) {
      reasoningTranslated += piece;
    }
  }

  const durationMs = opts.clock.now() - startedAt;
  done = true;

  if (emitEvents) {
    opts.log.append({
      type: 'thought.done',
      actor: 'butler',
      payload: {
        taskId: opts.taskId,
        reasoningLength: reasoning.length,
        reasoningTranslatedLength: reasoningTranslated.length,
        answerLength: answer.length,
        chunks,
        firstChunkMs,
        durationMs,
        translated: translationStats !== null,
        translationFailed: translationStats?.failed ?? 0,
        toolCallCount: toolCalls.size,
      },
      createdAt: opts.clock.now(),
    });
  }

  opts.onUpdate({ ...state(), done: true });

  return {
    reasoning,
    reasoningTranslated,
    answer,
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
    chunks,
    firstChunkMs: firstChunkMs ?? durationMs,
    durationMs,
    translation: translationStats,
    toolCalls: [...toolCalls.entries()].map(([callId, v]) => ({
      callId,
      name: v.name,
      args: v.args,
    })),
  };
}

/** 从流分片里累积完整内容的工具（供不支持流式的场景复用）。 */
export function collectChunks(
  chunks: readonly ModelStreamChunk[],
): { readonly reasoning: string; readonly text: string } {
  let reasoning = '';
  let text = '';
  for (const c of chunks) {
    if (c.kind === 'reasoning') reasoning += c.delta;
    else if (c.kind === 'text') text += c.delta;
  }
  return { reasoning, text };
}
