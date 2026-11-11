/**
 * 权限页交互逻辑的纯函数测试（不需要 jsdom）。
 *
 * 覆盖：
 *   · 点模式卡 → PUT 只带 `{ mode }`
 *   · 切确认开关 → PUT 只带 `{ confirmActions }`
 *   · 失败回滚到原状态（面板据此回滚选中态并 notify）
 *   · GET 未配置 / legacy 时不把“未配置”带进界面
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyPutResult,
  putPermissions,
  saveConfirmActions,
  saveMode,
  snapshotsFromGet,
  type PermissionsPatch,
  type PermissionsPutResponse,
  type PermissionsSnapshot,
} from '../permissions.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const VIEW: PermissionsSnapshot = { mode: 'view', confirmActions: true };

function recorder(reply: PermissionsPutResponse): {
  readonly calls: PermissionsPatch[];
  readonly put: (patch: PermissionsPatch) => Promise<PermissionsPutResponse>;
} {
  const calls: PermissionsPatch[] = [];
  return {
    calls,
    put: async (patch: PermissionsPatch): Promise<PermissionsPutResponse> => {
      calls.push(patch);
      return reply;
    },
  };
}

describe('snapshotsFromGet', () => {
  it('未配置 mode（null + legacy）预选仅查看，不把“未配置”带进界面', () => {
    const snapshot = snapshotsFromGet({ mode: null, confirmActions: true, legacy: true });
    expect(snapshot).toEqual({ mode: 'view', confirmActions: true });
    expect(Object.keys(snapshot)).toEqual(['mode', 'confirmActions']);
  });

  it('明确配置时保留模式；confirmActions 关闭状态保留', () => {
    expect(snapshotsFromGet({ mode: 'full', confirmActions: false })).toEqual({
      mode: 'full',
      confirmActions: false,
    });
  });

  it('confirmActions 缺省按后端默认开启处理', () => {
    const res = { mode: 'workspace' } as unknown as {
      readonly mode: 'workspace';
      readonly confirmActions: boolean;
    };
    expect(snapshotsFromGet(res).confirmActions).toBe(true);
  });
});

describe('saveMode · 点模式卡立即 PUT', () => {
  it('PUT 请求体只有 { mode }，成功后采用服务端结果', async () => {
    const rec = recorder({ ok: true, mode: 'full', confirmActions: true });
    const result = await saveMode(VIEW, 'full', rec.put);

    expect(rec.calls).toEqual([{ mode: 'full' }]);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.snapshot).toEqual({ mode: 'full', confirmActions: true });
  });

  it('失败回滚到原模式，并保留错误给调用方 notify', async () => {
    const failure = new Error('保存失败');
    const calls: PermissionsPatch[] = [];
    const result = await saveMode(VIEW, 'workspace', async (patch) => {
      calls.push(patch);
      throw failure;
    });

    expect(calls).toEqual([{ mode: 'workspace' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(failure);
    expect(result.snapshot).toEqual(VIEW);
  });

  it('点击当前已选模式不重复发请求', async () => {
    const rec = recorder({ mode: 'view', confirmActions: true });
    const result = await saveMode(VIEW, 'view', rec.put);
    expect(rec.calls).toEqual([]);
    expect(result.snapshot).toEqual(VIEW);
  });
});

describe('saveConfirmActions · 开关立即 PUT', () => {
  it('PUT 请求体只有 { confirmActions }', async () => {
    const rec = recorder({ ok: true, mode: 'workspace', confirmActions: false });
    const result = await saveConfirmActions(
      { mode: 'workspace', confirmActions: true },
      false,
      rec.put,
    );

    expect(rec.calls).toEqual([{ confirmActions: false }]);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual({ mode: 'workspace', confirmActions: false });
  });

  it('失败回滚开关，不会停在乐观值', async () => {
    const result = await saveConfirmActions(
      { mode: 'full', confirmActions: true },
      false,
      async () => {
        throw new Error('网络错误');
      },
    );

    expect(result.ok).toBe(false);
    expect(result.snapshot).toEqual({ mode: 'full', confirmActions: true });
  });
});

describe('applyPutResult', () => {
  it('服务端返回 null / 非法 mode 时保留已有模式', () => {
    expect(applyPutResult(VIEW, { mode: null, confirmActions: true }).mode).toBe('view');
    expect(
      applyPutResult(
        { mode: 'workspace', confirmActions: true },
        { mode: 'bogus' as unknown as 'full', confirmActions: true },
      ).mode,
    ).toBe('workspace');
  });
});

describe('PUT /api/permissions · 真实网络出口', () => {
  function stubFetch(reply: unknown): { readonly url: string; readonly init: RequestInit | undefined }[] {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return calls;
  }

  it('点模式卡：PUT /api/permissions，body 只有 { mode }', async () => {
    const calls = stubFetch({ ok: true, mode: 'full', confirmActions: true });

    const result = await saveMode(VIEW, 'full', putPermissions);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/permissions');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ mode: 'full' });
  });

  it('切确认开关：PUT /api/permissions，body 只有 { confirmActions }', async () => {
    const calls = stubFetch({ ok: true, mode: 'workspace', confirmActions: false });

    const result = await saveConfirmActions(
      { mode: 'workspace', confirmActions: true },
      false,
      putPermissions,
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/permissions');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ confirmActions: false });
  });

  it('HTTP 失败会回滚并带上服务端错误文案', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> =>
      new Response(JSON.stringify({ error: '写盘失败' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await saveMode(VIEW, 'workspace', putPermissions);

    expect(result.ok).toBe(false);
    expect(result.snapshot).toEqual(VIEW);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('写盘失败');
  });
});

