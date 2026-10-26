import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({ getRuntime: mocks.getRuntime }));

import { SessionStore } from '@/core/chat/types.js';
import { POST } from '../route.js';

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
