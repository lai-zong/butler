/**
 * 会话短标题生成。
 *
 * 只负责“第一轮对话 → 6–16 字标题”这一个动作；调用失败由调用方回退到
 * 第一句话截断，不影响聊天。生成结果写入 session-display sidecar。
 */

import { msg, type ModelPort } from '@/core/ports/model.js';

export interface TitleSource {
  readonly userText: string;
}

function cleanTitle(raw: string): string | null {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'“”‘’《》「」【】]+/u, '').replace(/["'“”‘’《》「」【】]+$/u, '');
  text = text.replace(/[。！？!?；;：:，,、]+$/u, '').trim();
  if (text.length === 0) return null;
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

export async function generateSessionTitle(
  model: ModelPort | null,
  source: TitleSource,
): Promise<string | null> {
  if (model === null) return null;
  const userText = source.userText.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (userText.length === 0) return null;

  try {
    const result = await model.complete({
      purpose: 'title',
      thinking: 'disabled',
      temperature: 0.2,
      maxOutputTokens: 48,
      messages: [
        msg.system(
          [
            '你是一个会话命名器。',
            '根据用户的第一句话，生成一个 6 到 16 个汉字的短标题，概括用户真正想做的事。',
            '不要引号、句号、感叹号，不要复述整句话，不要写“用户询问”之类的前缀。',
            '只输出标题本身，不要解释。',
          ].join('\n'),
        ),
        msg.user(`用户的第一句话：${userText}`),
      ],
    });
    if (result.finishReason !== 'stop' && result.finishReason !== 'length') return null;
    return cleanTitle(result.text);
  } catch {
    return null;
  }
}
