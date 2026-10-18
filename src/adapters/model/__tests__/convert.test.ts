/**
 * 消息转换测试（`partToApi` / `toApiMessages`）
 *
 * ★ 这个文件之前**不存在** —— 适配器层是最靠近协议的地方，
 *   却一直没有单元测试。补上时顺带覆盖了 E3（图片送进模型）。
 */
import { describe, expect, it } from 'vitest';

import { partToApi, toApiMessages, type ApiMessage, type ContentPart } from '../convert.js';
import type { ModelMessage } from '../../../core/ports/model.js';

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * 取出数组形态的 content。
 * ⚠️ 用类型守卫而不是 `as` 断言 —— 断言会让"本该是数组却给了 string"这种
 *    回归悄悄通过（正是这类断言掩盖了旧 bug）。
 */
function asParts(content: ApiMessage['content']): readonly ContentPart[] {
  if (content === null || typeof content === 'string') {
    throw new Error(`期望数组形态的 content，实际是 ${content === null ? 'null' : 'string'}`);
  }
  return content;
}

describe('partToApi —— 纯文本（旧行为不能被破坏）', () => {
  it('文本消息仍然是 string content（不因为支持图片就全改成数组）', () => {
    const m: ModelMessage = { role: 'user', content: [{ kind: 'text', text: '你好' }] };
    const [api] = partToApi(m);
    expect(api?.content).toBe('你好');
    expect(Array.isArray(api?.content)).toBe(false);
  });

  it('多个文本片段用换行拼接', () => {
    const m: ModelMessage = {
      role: 'user',
      content: [
        { kind: 'text', text: '第一段' },
        { kind: 'text', text: '第二段' },
      ],
    };
    expect(partToApi(m)[0]?.content).toBe('第一段\n第二段');
  });
});

describe('partToApi —— 工具调用与结果', () => {
  it('toolCall 转成 OpenAI 的函数调用形状', () => {
    const m: ModelMessage = {
      role: 'assistant',
      content: [{ kind: 'toolCall', callId: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
    };
    const [api] = partToApi(m);
    expect(api?.content).toBeNull();
    expect(api?.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(api?.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.txt"}');
  });

  it('toolResult 单独成为一条 role=tool 消息', () => {
    const m: ModelMessage = {
      role: 'user',
      content: [{ kind: 'toolResult', callId: 'c1', result: { ok: true } }],
    };
    const out = partToApi(m);
    const toolMsg = out.find((x) => x.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('c1');
    expect(toolMsg?.content).toBe('{"ok":true}');
  });
});

describe('★ E3：图片真的送进模型（此前被静默丢弃）', () => {
  it('★★ user 消息里的图片 → content 变成数组，含 image_url', () => {
    const m: ModelMessage = {
      role: 'user',
      content: [
        { kind: 'text', text: '这张图里是什么？' },
        { kind: 'image', url: IMG },
      ],
    };
    const [api] = partToApi(m);

    expect(Array.isArray(api?.content)).toBe(true);
    const parts = asParts(api?.content ?? null);
    // 文本在前、图片在后
    expect(parts[0]?.type).toBe('text');
    expect(parts[1]?.type).toBe('image_url');
    const img = parts[1];
    expect(img?.type === 'image_url' ? img.image_url.url : undefined).toBe(IMG);
  });

  it('图片会带上 detail（读截图文字时要用 high）', () => {
    const m: ModelMessage = {
      role: 'user',
      content: [
        { kind: 'text', text: '读一下' },
        { kind: 'image', url: IMG, detail: 'high' },
      ],
    };
    const parts = asParts(partToApi(m)[0]?.content ?? null);
    const img = parts[1];
    expect(img?.type === 'image_url' ? img.image_url.detail : undefined).toBe('high');
  });

  it('只有图片没有文字 → 数组里只有 image_url（不塞空文本块）', () => {
    const m: ModelMessage = { role: 'user', content: [{ kind: 'image', url: IMG }] };
    const parts = asParts(partToApi(m)[0]?.content ?? null);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('image_url');
  });

  it('★★★ 图片放在 system 消息 → **明确报错**，不静默丢弃', () => {
    /**
     * 协议限制：图片只能放 user 消息，放 system/assistant 会被 API 400 拒绝。
     *
     * ⚠️ 改之前的行为是 `break`（静默丢弃）—— 模型看不到图，
     *    而没人知道为什么。这正是这个缺口能存在很久的原因。
     */
    const m: ModelMessage = {
      role: 'system',
      content: [
        { kind: 'text', text: '系统提示' },
        { kind: 'image', url: IMG },
      ],
    };
    expect(() => partToApi(m)).toThrow(/只能放在 user 消息/);
  });

  it('assistant 消息里的图片同样报错', () => {
    const m: ModelMessage = { role: 'assistant', content: [{ kind: 'image', url: IMG }] };
    expect(() => partToApi(m)).toThrow(/user 消息/);
  });
});

describe('toApiMessages —— 多消息拼接', () => {
  it('按顺序展开，且只有带图的那条是数组', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: [{ kind: 'text', text: '你是管家' }] },
      {
        role: 'user',
        content: [
          { kind: 'text', text: '看图' },
          { kind: 'image', url: IMG },
        ],
      },
    ];
    const out = toApiMessages(messages);
    expect(out).toHaveLength(2);
    expect(typeof out[0]?.content).toBe('string');
    expect(Array.isArray(out[1]?.content)).toBe(true);
  });
});
