/**
 * 每日日记提示词。
 *
 * 两条硬纪律：
 *   1. 领域无关：不写“美食要营养 / 医疗要治好 / 编程要没 bug”这类口号；
 *   2. 只写发生过的事：日记与候选都必须能从输入消息找到依据。
 */

import { msg, type ModelMessage } from '../ports/model.js';
import type { DiarySourceMessage } from './types.js';

export const DIARY_PROMPT_VERSION = 'diary.v1';

export function diarySystemPrompt(): string {
  return `你是这个系统的“每日记录员”。请把当天对话整理成一篇日记，并提取少量值得长期记住的条目。

## 最重要的边界

1. 只写当天实际发生的事，不写领域口号、常识或“应该怎样”。
2. 不要按领域写规则。饮食、医疗、编程、美术等都只是内容，
   不要生成“美食要营养均衡”“医疗要严谨”“编程不能有 bug”“美术要好看”这类空话。
3. AI 推断不是事实。没有明确依据的内容，不要写成事实或硬约束。
4. 不要创造用户没有说过的偏好、约定或安全约束。
5. 日记是经历摘要，不是判决书；不确定的地方写“不确定”。

## 日记怎么写

- 用 2—6 段连贯中文，按时间或主题组织；
- 写清：发生了什么、用户明确说了什么、做了什么决定、还有什么没解决；
- 不复述每一句话，不写流水账；
- 不写技术实现细节，不写“系统认为”“模型判断”这类内部语言；
- 篇幅控制在 200—1200 字；内容少就写短。

## 候选条目怎么提

只提取**未来可能真正有用**的内容，最多 8 条，宁缺毋滥：

- fact：用户明确说过、可验证的事实；
- preference：用户表现出的稳定偏好（一次观察要保守，置信度低于 0.6）；
- principle：多次验证后可复用的行为原则，必须给出适用条件和动作。

每条必须：

- 用一句话写清；
- 给出 evidence（输入消息里的 [msg:...] id）；
- 置信度诚实：单次观察 0.4—0.6，多次验证才可 0.8 以上；
- 不重复既有记忆；
- 不能把 AI 推断写成硬约束。

如果当天没有值得长期保留的内容，items 返回空数组。这是正常的。`;
}

export interface DiaryPromptInput {
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly messages: readonly DiarySourceMessage[];
  readonly existingMemories?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly content: string;
  }[];
}

export function diaryUserPrompt(input: DiaryPromptInput): string {
  const existing =
    input.existingMemories && input.existingMemories.length > 0
      ? input.existingMemories
          .slice(0, 30)
          .map((m) => `- [${m.id}] (${m.kind}) ${m.content}`)
          .join('\n')
      : '（无）';

  const lines = input.messages.map(
    (m) => `[msg:${m.id}] ${m.role}: ${m.text.replace(/\s+/g, ' ').trim()}`,
  );

  return `日期键：${input.dayKey}
时间范围：${new Date(input.startAt).toISOString()} — ${new Date(input.endAt).toISOString()}

## 已有记忆（用于避免重复）

${existing}

## 当天消息

${lines.join('\n')}

请输出 JSON：diary + items。`;
}

export function diaryMessages(input: DiaryPromptInput): readonly ModelMessage[] {
  return [msg.system(diarySystemPrompt()), msg.user(diaryUserPrompt(input))];
}
