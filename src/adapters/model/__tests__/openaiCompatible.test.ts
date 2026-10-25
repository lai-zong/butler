import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenAICompatibleModel, openAIConfigFromEnv } from '../openaiCompatible.js';
import { msg } from '../../../core/ports/model.js';

let server: ReturnType<typeof createServer> | null = null;
let lastBody: Record<string, unknown> | null = null;

afterEach(async () => {
  lastBody = null;
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function start(): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages?: unknown };
      lastBody = body as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: `兼容端点收到 ${JSON.stringify(body.messages)}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/v1`;
}

describe('OpenAI 兼容适配器', () => {
  it('通过真实 HTTP 端点完成一次非流式调用', async () => {
    const baseUrl = await start();
    const model = new OpenAICompatibleModel(
      { apiKey: 'sk-test', baseUrl, model: 'test-model' },
      'test-provider',
    );
    const res = await model.complete({
      purpose: 'routing',
      messages: [msg.user('你好')],
    });
    expect(res.text).toContain('兼容端点收到');
    expect(res.usage.inputTokens).toBe(2);
    expect(res.usage.outputTokens).toBe(4);
    // DeepSeek 专有字段不能发给 OpenAI 兼容端点（部分实现会 400）。
    expect(lastBody).not.toBeNull();
    expect(lastBody).not.toHaveProperty('thinking');
    expect(lastBody).not.toHaveProperty('reasoning_effort');
  });

  it('从 OPENAI_* 读取配置，不误用 DeepSeek 变量', () => {
    const cfg = openAIConfigFromEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://example.test/v1',
      OPENAI_MODEL: 'test-model',
      DEEPSEEK_API_KEY: 'sk-deepseek-should-not-be-used',
    });
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.baseUrl).toBe('https://example.test/v1');
    expect(cfg.model).toBe('test-model');
  });

  it('describe 标明 openai-compatible，不冒充 DeepSeek', () => {
    const model = new OpenAICompatibleModel({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
    });
    expect(model.describe().provider).toBe('openai-compatible');
  });

  it('缺少 OPENAI_API_KEY 明确报错', () => {
    expect(() => openAIConfigFromEnv({})).toThrow(/OPENAI_API_KEY/);
  });
});
