/**
 * 真实运行时集成测试（不是 mock handler）
 *
 * 目的：补上“路由测试用的是 fake runtime”这一层证据。
 * 本文件在临时 BUTLER_DATA_DIR 下启动真实 ButlerRuntime，走真实事件流、
 * 真实 ActivityObserver、真实 OperationMemoryStore。
 *
 * ⚠️ 不调用模型（没有 API key，model=null），只测本地数据端点。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let dir = '';
let runtimeModule: typeof import('@/app/runtime');
let observation: typeof import('@/app/api/observation/route.js');
let demo: typeof import('@/app/api/activity/demo/route.js');
let operations: typeof import('@/app/api/operations/route.js');
let artifactDownload: typeof import('@/app/api/artifacts/[id]/download/route.js');
let verdict: typeof import('@/app/api/memory/verdict/route.js');

const prevEnv = {
  dataDir: process.env['BUTLER_DATA_DIR'],
  userId: process.env['BUTLER_USER_ID'],
  mcpPath: process.env['MCP_CONFIG_PATH'],
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'butler-e2e-'));
  process.env['BUTLER_DATA_DIR'] = dir;
  process.env['BUTLER_USER_ID'] = 'e2e_user';
  process.env['MCP_CONFIG_PATH'] = join(dir, 'mcp.json');

  vi.resetModules();
  runtimeModule = await import('@/app/runtime');
  observation = await import('@/app/api/observation/route.js');
  demo = await import('@/app/api/activity/demo/route.js');
  operations = await import('@/app/api/operations/route.js');
  artifactDownload = await import('@/app/api/artifacts/[id]/download/route.js');
  verdict = await import('@/app/api/memory/verdict/route.js');

  // 防止同 worker 里别的 runtime 复用旧 DATA_DIR
  await runtimeModule.resetRuntime();
  await runtimeModule.getRuntime();
}, 60_000);

afterAll(async () => {
  await runtimeModule?.resetRuntime().catch(() => undefined);
  if (prevEnv.dataDir === undefined) delete process.env['BUTLER_DATA_DIR'];
  else process.env['BUTLER_DATA_DIR'] = prevEnv.dataDir;
  if (prevEnv.userId === undefined) delete process.env['BUTLER_USER_ID'];
  else process.env['BUTLER_USER_ID'] = prevEnv.userId;
  if (prevEnv.mcpPath === undefined) delete process.env['MCP_CONFIG_PATH'];
  else process.env['MCP_CONFIG_PATH'] = prevEnv.mcpPath;
  if (dir.length > 0) await rm(dir, { recursive: true, force: true });
}, 30_000);

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('真实运行时 · 本地端点', () => {
  it('默认未同意采集；显式同意后演示数据可导入并聚合', async () => {
    const before = await observation.GET();
    const beforeBody = (await before.json()) as { granted: boolean };
    expect(beforeBody.granted).toBe(false);

    const grant = await observation.POST(
      jsonReq('http://localhost/api/observation', { granted: true }),
    );
    expect(grant.status).toBe(200);

    const r = await demo.POST(
      jsonReq('http://localhost/api/activity/demo', { profile: 'office-dev', days: 2 }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { recorded: number; generated: number };
    expect(body.recorded).toBe(body.generated);
    expect(body.recorded).toBeGreaterThan(0);

    const activity = await (await import('@/app/api/activity/route.js')).GET();
    const ab = (await activity.json()) as { raw: unknown[]; aggregates: unknown[] };
    expect(ab.aggregates.length).toBeGreaterThan(0);
  }, 30_000);

  it('显式偏好写入真实 OperationMemoryStore，可被 GET 读到', async () => {
    const r = await operations.POST(
      jsonReq('http://localhost/api/operations', {
        kind: 'preference',
        content: '喜欢简短回复',
        taskLabel: '写邮件',
      }),
    );
    expect(r.status).toBe(200);

    const list = await operations.GET(
      new NextRequest('http://localhost/api/operations?kind=preference'),
    );
    const body = (await list.json()) as { operations: { content: string }[] };
    expect(body.operations.some((o) => o.content === '喜欢简短回复')).toBe(true);
  }, 30_000);

  it('真实仓储下 CSV 下载 404 / 非法格式 400', async () => {
    const missing = await artifactDownload.GET(
      new NextRequest('http://localhost/api/artifacts/missing/download?format=csv'),
      ctx('missing'),
    );
    expect(missing.status).toBe(404);
  }, 15_000);

  it('真实 store 下裁决缺失记忆返回 404', async () => {
    const r = await verdict.POST(
      jsonReq('http://localhost/api/memory/verdict', {
        winnerId: 'missing-a',
        loserId: 'missing-b',
      }),
    );
    expect(r.status).toBe(404);
  }, 15_000);
});
