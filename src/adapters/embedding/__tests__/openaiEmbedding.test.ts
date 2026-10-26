import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIEmbedding } from '../openaiEmbedding.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((ok) => server.close(() => ok())),
    ),
  );
});

async function mockServer(
  handler: (body: Record<string, unknown>, authorization: string) => unknown,
): Promise<number> {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        res.end(JSON.stringify(handler(body, String(req.headers.authorization ?? ''))));
      } catch {
        res.statusCode = 500;
        res.end('{}');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

describe('OpenAIEmbedding', () => {
  it('调用 /embeddings，按 index 还原顺序并校验维度', async () => {
    let auth = '';
    let request: Record<string, unknown> = {};
    const port = await mockServer((body, authorization) => {
      request = body;
      auth = authorization;
      return {
        data: [
          { index: 1, embedding: [4, 5, 6] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      };
    });
    const adapter = new OpenAIEmbedding({
      model: 'test-embedding',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      dimensions: 3,
    });
    const vectors = await adapter.embed(['甲', '乙']);
    expect(vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(request).toMatchObject({
      model: 'test-embedding',
      input: ['甲', '乙'],
      dimensions: 3,
    });
    expect(auth).toBe('Bearer test-key');
  });

  it('拒绝非法或重复的向量索引', async () => {
    const port = await mockServer(() => ({
      data: [{ index: 2, embedding: [1, 2, 3] }],
    }));
    const adapter = new OpenAIEmbedding({
      model: 'test-embedding',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: '',
      dimensions: 3,
    });
    await expect(adapter.embed(['甲'])).rejects.toThrow('非法或重复的向量索引');
  });

  it('维度不一致时拒绝使用向量', async () => {
    const port = await mockServer(() => ({
      data: [{ index: 0, embedding: [1, 2] }],
    }));
    const adapter = new OpenAIEmbedding({
      model: 'test-embedding',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: '',
      dimensions: 3,
    });
    await expect(adapter.embed(['甲'])).rejects.toThrow('嵌入维度不匹配');
  });
});
