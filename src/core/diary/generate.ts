/**
 * 生成一篇日记 + 候选条目。
 *
 * 一次模型调用；不先写散文再二次抽取。
 */

import type { ClockPort } from '../ports/clock.js';
import type { ModelPort } from '../ports/model.js';
import type { DiaryEntry, DiaryExtractedItem, DiarySourceMessage } from './types.js';
import { diaryMessages, DIARY_PROMPT_VERSION } from './prompt.js';
import { diarySchema } from './schema.js';
import { dayWindow } from './time.js';

export const MAX_DIARY_MESSAGES = 200;
export const MAX_DIARY_INPUT_CHARS = 24_000;

export interface GenerateDiaryArgs {
  readonly model: ModelPort;
  readonly clock: ClockPort;
  readonly sessionId: string;
  readonly userId: string;
  readonly dayKey: string;
  readonly messages: readonly DiarySourceMessage[];
  readonly existingMemories?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly content: string;
  }[];
  /** 当天没有可总结内容时由调用方跳过；这里再兜底一次。 */
  readonly minUserMessages?: number;
}

export interface GenerateDiaryResult {
  readonly entry: DiaryEntry;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

function clipMessages(messages: readonly DiarySourceMessage[]): readonly DiarySourceMessage[] {
  const selected = messages.slice(-MAX_DIARY_MESSAGES);
  const out: DiarySourceMessage[] = [];
  let chars = 0;
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const m = selected[i];
    if (!m) continue;
    const text = m.text.trim();
    if (!text) continue;
    if (chars + text.length > MAX_DIARY_INPUT_CHARS && out.length > 0) break;
    out.push({ ...m, text: text.slice(0, 4000) });
    chars += text.length;
  }
  return out.reverse();
}

function validEvidence(ids: readonly string[], allowed: Set<string>): readonly string[] {
  return [...new Set(ids.filter((id) => allowed.has(id)))];
}

export async function generateDiary(args: GenerateDiaryArgs): Promise<GenerateDiaryResult> {
  const window = dayWindow(args.dayKey);
  const messages = clipMessages(args.messages);
  const allowed = new Set(messages.map((m) => m.id));

  const userMessages = messages.filter((m) => m.role === 'user');
  const min = args.minUserMessages ?? 4;
  if (userMessages.length < min) {
    throw new Error(`not enough user messages for diary: ${userMessages.length} < ${min}`);
  }

  const result = await args.model.completeStructured({
    purpose: 'memoryExtraction',
    schema: diarySchema,
    schemaName: 'DailyDiary',
    temperature: 0.2,
    thinking: 'disabled',
    messages: diaryMessages({
      dayKey: args.dayKey,
      startAt: window.startAt,
      endAt: window.endAt,
      messages,
      ...(args.existingMemories !== undefined
        ? { existingMemories: args.existingMemories }
        : {}),
    }),
  });

  const diaryId = `diary_${args.sessionId}_${args.dayKey}`;
  const items: DiaryExtractedItem[] = [];
  for (let i = 0; i < result.value.items.length; i += 1) {
    const raw = result.value.items[i];
    if (!raw) continue;
    const evidence = validEvidence(raw.evidence, allowed);
    // 没有可验证来源的条目直接丢弃：日记可以叙述，记忆条目必须有证据。
    if (evidence.length === 0) continue;
    if (raw.kind === 'principle' && (!raw.principleCondition || !raw.principleAction)) {
      // 原则缺少条件/动作就无法注入，也无法检测违背，降级为事实/偏好候选。
      items.push({
        id: `${diaryId}_item_${i}`,
        kind: 'preference',
        content: raw.content,
        confidence: Math.min(raw.confidence, 0.55),
        evidence,
        rationale: '原则缺少适用条件或动作，降级为低置信偏好候选',
      });
      continue;
    }
    items.push({
      id: `${diaryId}_item_${i}`,
      kind: raw.kind,
      content: raw.content,
      confidence: raw.confidence,
      evidence,
      rationale: raw.rationale ?? '',
      ...(raw.kind === 'principle' && raw.principleCondition && raw.principleAction
        ? {
            principle: {
              condition: raw.principleCondition,
              action: raw.principleAction,
            },
          }
        : {}),
    });
  }

  const entry: DiaryEntry = {
    id: diaryId,
    scopeId: `session:${args.sessionId}`,
    sessionId: args.sessionId,
    userId: args.userId,
    dayKey: args.dayKey,
    startAt: window.startAt,
    endAt: window.endAt,
    content: result.value.diary.trim(),
    items,
    sourceMessageIds: messages.map((m) => m.id),
    model: args.model.describe().model,
    promptVersion: DIARY_PROMPT_VERSION,
    usage: result.usage,
    createdAt: args.clock.now(),
  };

  return { entry, usage: result.usage };
}
