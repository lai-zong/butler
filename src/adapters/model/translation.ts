/**
 * 思考翻译端口（DeepSeek 实现）
 *
 * 设计依据：方案 B4「英文思考按句边界增量翻译」
 *
 * ★ 只做一个翻译调用，不负责切句/并发/保序 —— 那些在
 *   `core/stream/translate.ts` 的 `IncrementalTranslator` 里。
 *   端口保持最小，测试与替换才简单。
 *
 * ⚠️ 默认要求关闭 thinking：翻译是短任务，思考会吃掉输出预算；
 *    且译文应直接可读，不需要模型先"想一想"。
 */

import type { ModelPort } from '../../core/ports/model.js';
import { msg } from '../../core/ports/model.js';
import type { TranslationPort } from '../../core/stream/translate.js';

const SYSTEM = `你是英文思考的中文翻译器。
只把用户给出的英文片段翻译成简体中文，保留代码、命令、文件路径、专有名词和数字。
不要解释、不要总结、不要加前后缀；只输出译文。`;

export function deepSeekTranslationPort(model: ModelPort): TranslationPort {
  return {
    async translate(text: string, signal?: AbortSignal): Promise<string> {
      const res = await model.complete({
        purpose: 'translation',
        messages: [msg.system(SYSTEM), msg.user(text)],
        temperature: 0,
        thinking: 'disabled',
        maxOutputTokens: Math.min(4096, Math.max(256, text.length * 2)),
        ...(signal !== undefined ? { signal } : {}),
      });
      const translated = res.text.trim();
      if (translated.length === 0) {
        throw new Error('翻译模型返回空文本');
      }
      return translated;
    },
  };
}
