import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({ getRuntime: mocks.getRuntime }));

import { SessionStore } from '@/core/chat/types.js';
import { GET, POST } from '../route.js';

let now = 1_800_000_000_000;
let chat: SessionStore;
let log: {
  append: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  flushPersistence: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  now = 1_800_000_000_000;
  const events: unknown[] = [];
  log = {
    append: vi.fn((event: unknown) => events.push(event)),
    all: vi.fn(() => events),
    flushPersistence: vi.fn(async () => undefined),
  };
  chat = new SessionStore(log as never, { now: () => now }, 'u');
  mocks.getRuntime.mockResolvedValue({
    bootstrapped: {
      chat,
      log,
    },
    workspaceRoot: 'C:\\app-default',
    permissionPolicy: { mode: 'view' },
  });
});

describe('GET /api/sessions', () => {
  it('列表带 workspace/permission/effective* 且旧 session 补 null', async () => {
    const created = await POST();
    const createdBody = (await created.json()) as { session: { id: string } };
    const session = chat.getSession(createdBody.session.id)!;
    // 新会话默认 null/null
    expect(session.workspace).toBeNull();
    expect(session.permission).toBeNull();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        workspace: string | null;
        permission: string | null;
        effectiveWorkspace: string;
        effectivePermission: string;
        settings: {
          workspace: string | null;
          permission: string | null;
          effectiveWorkspace: string;
          effectivePermission: string;
        };
      }>;
    };
    expect(body.sessions).toHaveLength(1);
    const dto = body.sessions[0]!;
    expect(dto.workspace).toBeNull();
    expect(dto.permission).toBeNull();
    expect(dto.effectiveWorkspace).toBe('C:\\app-default');
    // 全局 mode=view → 只读
    expect(dto.effectivePermission).toBe('read-only');
    expect(dto.settings.workspace).toBeNull();
    expect(dto.settings.permission).toBeNull();
    expect(dto.settings.effectiveWorkspace).toBe('C:\\app-default');
    expect(dto.settings.effectivePermission).toBe('read-only');
  });
});

describe('POST /api/sessions', () => {
  it('连续新建对话时复用同一个空草稿', async () => {
    const first = await POST();
    const second = await POST();
    const a = (await first.json()) as { session: { id: string; messageCount: number } };
    const b = (await second.json()) as { session: { id: string; messageCount: number } };

    expect(a.session.messageCount).toBe(0);
    expect(b.session.id).toBe(a.session.id);
    expect(chat.listSessions()).toHaveLength(1);
  });

  it('草稿发出第一条消息后，下一次新建会创建新草稿', async () => {
    const first = await POST();
    const a = (await first.json()) as { session: { id: string } };
    const session = chat.getSession(a.session.id);
    expect(session).toBeDefined();
    if (session === undefined) return;

    now += 1_000;
    chat.appendMessage(session.id, { role: 'user', text: '开始吧' });

    const second = await POST();
    const b = (await second.json()) as { session: { id: string; messageCount: number } };
    expect(b.session.id).not.toBe(a.session.id);
    expect(b.session.messageCount).toBe(0);
    expect(chat.listSessions()).toHaveLength(2);
  });
});
