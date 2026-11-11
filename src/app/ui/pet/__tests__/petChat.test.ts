import { describe, expect, it } from 'vitest';

import {
  applyPetEvent,
  foldPetTurn,
  groupPetMessages,
  historyContainsTurn,
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
