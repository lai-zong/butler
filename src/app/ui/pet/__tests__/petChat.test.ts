import { describe, expect, it, vi } from 'vitest';

import {
  applyPetEvent,
  createPetSseParser,
  foldPetTurn,
  groupPetMessages,
  historyContainsTurn,
  openPetChat,
  petMessagesFromHistory,
  toPetEvent,
  type PetEvent,
  type PetMessage,
  type PetTurn,
} from '../petChat.js';
import type { MessageDto } from '../../lib/types.js';

function runningTurn(patch: Partial<PetTurn> = {}): PetTurn {
  return {
    id: 'turn-1',
    userText: '整理一下文件',
    outgoingText: '整理一下文件',
    milestones: [],
    reply: '',
    status: 'running',
    error: null,
    startedAt: 1_000,
    ...patch,
  };
}

describe('桌宠 SSE：只收 milestone / reply', () => {
  it('milestone 被收窄成可展示事件', () => {
    expect(toPetEvent({ type: 'milestone', text: ' 文件读到了 ' })).toEqual({
      kind: 'milestone',
      text: '文件读到了',
    });
    expect(toPetEvent({ type: 'milestone', text: '   ' })).toBeNull();
  });

  it('旧的 progress / narration / stage 不再进入桌宠', () => {
    expect(
      toPetEvent({ type: 'progress', event: { kind: 'stage', label: '写任务契约' } }),
    ).toBeNull();
    expect(toPetEvent({ type: 'narration', answer: '先说一段过程' })).toBeNull();
    expect(toPetEvent({ type: 'stage', label: '开始执行' })).toBeNull();
  });
});

describe('桌宠轮次折叠', () => {
  it('milestone 按到达顺序追加，重复文案去重', () => {
    const first = applyPetEvent(runningTurn(), {
      kind: 'milestone',
      text: '我先理一下怎么做。',
    } satisfies PetEvent);
    const second = applyPetEvent(first, { kind: 'milestone', text: '文件读到了，我继续看。' });
    const duplicate = applyPetEvent(second, { kind: 'milestone', text: '文件读到了，我继续看。' });

    expect(duplicate.milestones).toEqual([
      '我先理一下怎么做。',
      '文件读到了，我继续看。',
    ]);
    expect(duplicate.status).toBe('running');
  });

  it('聊天没有 milestone：最终只得到一个结果', () => {
    const done = applyPetEvent(runningTurn(), { kind: 'reply', text: '你好呀。' });
    expect(done.milestones).toEqual([]);
    expect(done.reply).toBe('你好呀。');
    expect(done.status).toBe('done');
  });

  it('任务最终回答与 milestone 分开保留', () => {
    const withMilestone = applyPetEvent(runningTurn(), {
      kind: 'milestone',
      text: '目录看到了，我继续找。',
    });
    const done = applyPetEvent(withMilestone, { kind: 'reply', text: '都整理好了。' });
    expect(done.milestones).toEqual(['目录看到了，我继续找。']);
    expect(done.reply).toBe('都整理好了。');
  });
});

describe('微信式分组', () => {
  it('progress 不互相合并，也不和 final 合并', () => {
    const messages: PetMessage[] = [
      { role: 'user', kind: 'user', text: '整理文件' },
      { role: 'assistant', kind: 'progress', text: '我先理一下怎么做。' },
      { role: 'assistant', kind: 'progress', text: '文件读到了，我继续看。' },
      { role: 'assistant', kind: 'final', text: '整理好了。' },
    ];
    const groups = groupPetMessages(messages);
    expect(groups.map((group) => group.kind)).toEqual(['user', 'progress', 'progress', 'final']);
    expect(groups.map((group) => group.text)).toEqual([
      '整理文件',
      '我先理一下怎么做。',
      '文件读到了，我继续看。',
      '整理好了。',
    ]);
  });

  it('连续 final 仍然合并成一个大气泡', () => {
    const groups = groupPetMessages([
      { role: 'assistant', kind: 'final', text: '第一段' },
      { role: 'assistant', kind: 'final', text: '第二段' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe('第一段\n\n第二段');
  });

  it('历史只产生 user / final，不带 progress', () => {
    const history = petMessagesFromHistory([
      { role: 'user', text: '帮我找文件', createdAt: 1 },
      { role: 'butler', text: '找到了。', createdAt: 2 },
    ] as MessageDto[]);
    expect(history.map((message) => message.kind)).toEqual(['user', 'final']);
  });
});

describe('foldPetTurn', () => {
  it('只折叠最终回答，里程碑不写入历史', () => {
    const history = foldPetTurn(
      [],
      runningTurn({
        milestones: ['我先理一下怎么做。', '文件读到了。'],
        reply: '整理好了。',
        status: 'done',
      }),
    );
    expect(history).toEqual([
      { role: 'user', kind: 'user', text: '整理一下文件' },
      { role: 'assistant', kind: 'final', text: '整理好了。' },
    ]);
  });

  it('历史已包含本轮时不再重复折叠', () => {
    const turn = runningTurn({ reply: '整理好了。', status: 'done' });
    const history: PetMessage[] = [
      { role: 'user', kind: 'user', text: '整理一下文件' },
      { role: 'assistant', kind: 'final', text: '整理好了。' },
    ];
    expect(historyContainsTurn(history, turn)).toBe(true);
    expect(foldPetTurn(history, turn)).toEqual(history);
  });
});

describe('桌宠审批事件', () => {
  it('approval 被收窄成队列项，只保留白名单字段', () => {
    const event = toPetEvent({
      type: 'approval',
      id: 'ap_1',
      toolName: 'write_file',
      tier: 'write',
      summary: '把整理结果写进 待办.md',
      preview: '待办.md',
      // 旧事件可能多带这两个字段；它们不能进入界面状态，否则以后又会冒出倒计时。
      timeoutMs: 120_000,
      receivedAt: 1_700_000_000_000,
    });

    expect(event).toEqual({
      kind: 'approval',
      approval: {
        id: 'ap_1',
        toolName: 'write_file',
        tier: 'write',
        summary: '把整理结果写进 待办.md',
        preview: '待办.md',
      },
    });
    if (event?.kind !== 'approval') throw new Error('approval 事件没有被解析出来');
    expect(event.approval).not.toHaveProperty('timeoutMs');
    expect(event.approval).not.toHaveProperty('receivedAt');
  });

  it('没有 preview 时不伪造空预览；preview 类型不对也丢掉', () => {
    expect(
      toPetEvent({
        type: 'approval',
        id: 'ap_2',
        toolName: 'write_file',
        tier: 'write',
        summary: '写文件',
      }),
    ).toEqual({
      kind: 'approval',
      approval: { id: 'ap_2', toolName: 'write_file', tier: 'write', summary: '写文件' },
    });

    expect(
      toPetEvent({
        type: 'approval',
        id: 'ap_3',
        toolName: 'write_file',
        tier: 'write',
        summary: '写文件',
        preview: 42,
      }),
    ).toEqual({
      kind: 'approval',
      approval: { id: 'ap_3', toolName: 'write_file', tier: 'write', summary: '写文件' },
    });
  });

  it('缺 id / summary 等必要字段时丢弃，不冒充一张能点的卡', () => {
    const base = {
      type: 'approval',
      id: 'ap_4',
      toolName: 'write_file',
      tier: 'write',
      summary: '写文件',
    };
    expect(toPetEvent({ ...base, id: undefined })).toBeNull();
    expect(toPetEvent({ ...base, id: '   ' })).toBeNull();
    expect(toPetEvent({ ...base, summary: undefined })).toBeNull();
    expect(toPetEvent({ ...base, summary: '   ' })).toBeNull();
    expect(toPetEvent({ ...base, toolName: undefined })).toBeNull();
    expect(toPetEvent({ ...base, tier: undefined })).toBeNull();
  });

  it('坏 JSON 只丢那一条，后面的正常事件继续', () => {
    const parser = createPetSseParser();
    const events = parser.push(
      'data: {"type":"approval","id":\n\n' +
        'data: {"type":"approval","id":"","toolName":"write_file","tier":"write","summary":"写文件"}\n\n' +
        'data: {"type":"approval","id":"ap_9","toolName":"write_file","tier":"write","summary":"写进 待办.md"}\n\n',
    );

    expect(events).toEqual([
      {
        kind: 'approval',
        approval: {
          id: 'ap_9',
          toolName: 'write_file',
          tier: 'write',
          summary: '写进 待办.md',
        },
      },
    ]);
  });

  it('审批不进轮次文本：reply / milestone 的既有行为不变', () => {
    expect(toPetEvent({ type: 'reply', text: '好，我直接做。' })).toEqual({
      kind: 'reply',
      text: '好，我直接做。',
    });
    expect(toPetEvent({ type: 'milestone', text: ' 文件读到了 ' })).toEqual({
      kind: 'milestone',
      text: '文件读到了',
    });

    const turn = runningTurn();
    const waiting: PetEvent = {
      kind: 'approval',
      approval: { id: 'ap_1', toolName: 'write_file', tier: 'write', summary: '写文件' },
    };
    expect(applyPetEvent(turn, waiting)).toBe(turn);
    expect(turn.reply).toBe('');
    expect(turn.status).toBe('running');
  });
});

describe('桌宠发消息的能力声明', () => {
  it('声明 supportsApproval（否则服务端会立刻拒绝需要确认的工具）', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as unknown);
      return new Response('{}', { status: 200 });
    });
    try {
      await openPetChat({
        sessionId: 'sess-1',
        text: '整理一下',
        images: ['data:image/png;base64,AA=='],
        signal: new AbortController().signal,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(bodies[0]).toEqual({
      sessionId: 'sess-1',
      text: '整理一下',
      supportsApproval: true,
      images: [{ url: 'data:image/png;base64,AA==' }],
    });
  });
});
