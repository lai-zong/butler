import { describe, expect, it, vi } from 'vitest';

import { MimoTts } from '../mimo.js';
import { OpenAiTts } from '../openai.js';

describe('OpenAI TTS 适配器', () => {
  it('调用 /audio/speech 并返回音频字节', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'tts-1', voice: 'alloy', input: '你好', response_format: 'mp3' });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    });
    const port = new OpenAiTts({
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      model: 'tts-1',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const out = await port.synthesize({ text: '你好', voice: 'alloy', format: 'mp3' });
    expect(Array.from(out.audio)).toEqual([1, 2, 3]);
    expect(out.contentType).toBe('audio/mpeg');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/v1/audio/speech');
  });
});

describe('MiMo TTS 适配器', () => {
  it('走 chat/completions，解析 base64 音频，assistant 放朗读文本', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['model']).toBe('mimo-v2.5-tts');
      expect(body['audio']).toEqual({ format: 'mp3', voice: '冰糖' });
      expect(body['messages']).toEqual([
        { role: 'user', content: '温柔地朗读' },
        { role: 'assistant', content: '你好' },
      ]);
      return new Response(JSON.stringify({
        choices: [{ message: { audio: { data: Buffer.from([9, 8, 7]).toString('base64') } } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const port = new MimoTts({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
      model: 'mimo-v2.5-tts',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const out = await port.synthesize({
      text: '你好',
      voice: '冰糖',
      style: '温柔地朗读',
      format: 'mp3',
    });
    expect(Array.from(out.audio)).toEqual([9, 8, 7]);
    expect(out.model).toBe('mimo-v2.5-tts');
  });
});
