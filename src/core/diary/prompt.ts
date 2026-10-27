/**
 * 每日日记提示词。
 *
 * 两条硬纪律：
 *   1. 领域无关：不写“美食要营养 / 医疗要治好 / 编程要没 bug”这类口号；
 *   2. 只写发生过的事：日记与候选都必须能从输入消息找到依据。
 */

import { msg, type ModelMessage } from '../ports/model.js';
import type { DiarySourceMessage } from './types.js';

export const DIARY_PROMPT_VERSION = 'diary.v2';

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
- preference：用户表现出的稳定偏好或缺省选择；
- principle：多次验证后可复用的行为原则，必须给出适用条件和动作。

### 先判断稳定性，再决定提取

每条候选都必须标 "stability"：

- "stable"：长期属性或长期偏好，例如长期忌口/过敏、作息、常用工具、流程偏好、
  审美偏好、沟通偏好；
- "temporary"：只对本次任务有效，例如这次库存、这次截止时间、本次任务范围、
  这次数量、这次主题；
- "unknown"：无法判断。

稳定信息即使只出现一次，也应该提取；不要因为“只出现一次”就把所有条目都丢掉。
临时的任务参数不要写成长期记忆。

建议置信度：

- 单次观察的稳定偏好：0.45—0.65；
- 用户明确、可验证的稳定事实：0.6—0.8；
- 只有多次验证的 principle 才给 0.8 以上；
- "temporary" 不提取。

空数组只用于**确实没有任何关于用户的稳定信息**时。只有临时任务参数时返回空数组；
有明确稳定偏好或长期事实时，应至少提取一条低置信条目，而不是保守地全部省略。

每条必须：

- 用一句话写清；
- 给出 evidence（输入消息里的 [msg:...] id）；
- 不能把 AI 推断写成事实或硬约束；
- 不重复既有记忆。

如果当天只有临时任务参数，没有长期价值，items 返回空数组；不要为了凑数提取。`;
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

