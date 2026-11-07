import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../types.js';
import {
  EMPTY_WORKSPACE_LABEL,
  PET_GROUP_KEY,
  compareUpdatedAtDesc,
  groupByWorkspace,
  isPinnedInWorkspace,
  needsGeneratedTitle,
  partitionByTime,
  sortByTime,
  workspaceBaseLabel,
  workspaceSegments,
} from '../sessionSort.js';

const DEFAULT_WORKSPACE = 'C:\\work\\alpha';

function summary(patch: Partial<SessionSummary> & { readonly id: string }): SessionSummary {
  const workspace = patch.effectiveWorkspace ?? DEFAULT_WORKSPACE;
  return {
    title: '标题',
    titleGenerated: false,
    pinnedAt: null,
    pinnedWorkspace: null,
    createdAt: 1,
    updatedAt: 10,
    turnCount: 1,
    messageCount: 2,
    verdictCount: 0,
    lastPreview: '',
    workspace: null,
    permission: null,
    effectiveWorkspace: workspace,
    effectivePermission: 'read-only',
    settings: {
      reasoning: 'high',
      memoryMode: 'on',
      hasPersona: false,
      personaLength: 0,
      personaPreview: '',
      persona: null,
      personaHash: '',
      workspace: null,
      permission: null,
      effectiveWorkspace: workspace,
      effectivePermission: 'read-only',
    },
    ...patch,
  };
}

describe('sortByTime', () => {
  it('置顶优先，置顶内按 updatedAt 倒序，其余按 updatedAt 倒序', () => {
    const list = [
      summary({ id: 'a', updatedAt: 100 }),
      summary({ id: 'b', updatedAt: 300, pinnedAt: 1, pinnedWorkspace: DEFAULT_WORKSPACE }),
      summary({ id: 'c', updatedAt: 500 }),
      summary({ id: 'd', updatedAt: 200, pinnedAt: 999, pinnedWorkspace: 'C:\\other' }),
      summary({ id: 'e', updatedAt: 400 }),
    ];
    // 置顶内部按 updatedAt（b=300 > d=200），与 pinnedAt 数值无关。
    expect(sortByTime(list).map((s) => s.id)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });

  it('同一 updatedAt 用 id 兜底，顺序稳定', () => {
    const list = [summary({ id: 'b', updatedAt: 5 }), summary({ id: 'a', updatedAt: 5 })];
    expect([...list].sort(compareUpdatedAtDesc).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('partitionByTime', () => {
  it('桌宠会话单独分区，即使 updatedAt 更新也不混进普通列表', () => {
    const petId = 'pet-1';
    const partition = partitionByTime(
      [
        summary({ id: 'a', updatedAt: 100 }),
        summary({ id: petId, updatedAt: 900 }),
        summary({ id: 'b', updatedAt: 300, pinnedAt: 1 }),
      ],
      petId,
    );
    expect(partition.rows.map((s) => s.id)).toEqual(['b', 'a']);
    expect(partition.pet.map((s) => s.id)).toEqual([petId]);
  });

  it('桌宠会话置顶也留在自己的分区里', () => {
    const petId = 'pet-1';
    const partition = partitionByTime(
      [
        summary({ id: 'a', updatedAt: 100 }),
        summary({ id: petId, updatedAt: 50, pinnedAt: 3, pinnedWorkspace: DEFAULT_WORKSPACE }),
      ],
      petId,
    );
    expect(partition.rows.map((s) => s.id)).toEqual(['a']);
    expect(partition.pet.map((s) => s.id)).toEqual([petId]);
  });

  it('没有桌宠会话时全部是普通行', () => {
    const partition = partitionByTime(
      [summary({ id: 'a', updatedAt: 100 }), summary({ id: 'b', updatedAt: 200 })],
      null,
    );
    expect(partition.rows.map((s) => s.id)).toEqual(['b', 'a']);
    expect(partition.pet).toEqual([]);
  });
});

describe('workspace 名称', () => {
  it('取路径末段，兼容反斜杠与正斜杠', () => {
    expect(workspaceBaseLabel('C:\\work\\alpha')).toBe('alpha');
    expect(workspaceBaseLabel('/home/me/beta/')).toBe('beta');
    expect(workspaceBaseLabel('')).toBe(EMPTY_WORKSPACE_LABEL);
  });

  it('拆段忽略空段', () => {
    expect(workspaceSegments('C:\\work\\\\alpha\\')).toEqual(['C:', 'work', 'alpha']);
  });
});

describe('isPinnedInWorkspace', () => {
  it('只有 pinnedWorkspace 与 effectiveWorkspace 相同才算组内置顶', () => {
    expect(
      isPinnedInWorkspace(
        summary({ id: 'a', pinnedAt: 1, pinnedWorkspace: DEFAULT_WORKSPACE }),
      ),
    ).toBe(true);
    expect(
      isPinnedInWorkspace(summary({ id: 'b', pinnedAt: 1, pinnedWorkspace: 'C:\\elsewhere' })),
    ).toBe(false);
    expect(isPinnedInWorkspace(summary({ id: 'c' }))).toBe(false);
  });
});

describe('groupByWorkspace', () => {
  it('按 effectiveWorkspace 分组，组按组内最新 updatedAt 排序', () => {
    const groups = groupByWorkspace(
      [
        summary({ id: 'a1', updatedAt: 100, effectiveWorkspace: 'C:\\work\\alpha' }),
        summary({ id: 'a2', updatedAt: 900, effectiveWorkspace: 'C:\\work\\alpha' }),
        summary({ id: 'b1', updatedAt: 500, effectiveWorkspace: 'C:\\work\\beta' }),
        summary({ id: 'c1', updatedAt: 300, effectiveWorkspace: 'C:\\work\\gamma' }),
      ],
      null,
    );
    expect(groups.map((g) => g.label)).toEqual(['alpha', 'beta', 'gamma']);
    expect(groups[0]?.rest.map((s) => s.id)).toEqual(['a2', 'a1']);
    expect(groups[0]?.latestUpdatedAt).toBe(900);
  });

  it('组内置顶优先，pinnedWorkspace 不跨组冒泡', () => {
    const groups = groupByWorkspace(
      [
        summary({ id: 'a-new', updatedAt: 900, effectiveWorkspace: 'C:\\work\\alpha' }),
        summary({
          id: 'a-pin',
          updatedAt: 100,
          effectiveWorkspace: 'C:\\work\\alpha',
          pinnedAt: 5,
          pinnedWorkspace: 'C:\\work\\alpha',
        }),
        summary({ id: 'b-new', updatedAt: 800, effectiveWorkspace: 'C:\\work\\beta' }),
        summary({
          id: 'a-pin-elsewhere',
          updatedAt: 700,
          effectiveWorkspace: 'C:\\work\\beta',
          pinnedAt: 6,
          pinnedWorkspace: 'C:\\work\\alpha',
        }),
      ],
      null,
    );
    const alpha = groups.find((g) => g.label === 'alpha');
    const beta = groups.find((g) => g.label === 'beta');
    expect(alpha?.pinned.map((s) => s.id)).toEqual(['a-pin']);
    expect(alpha?.rest.map((s) => s.id)).toEqual(['a-new']);
    // 在 alpha 置顶的会话换到 beta 后不算 beta 的置顶，但仍按时间排。
    expect(beta?.pinned).toEqual([]);
    expect(beta?.rest.map((s) => s.id)).toEqual(['b-new', 'a-pin-elsewhere']);
  });

  it('桌宠会话单独成区，不混入工作区分组', () => {
    const petId = 'pet-1';
    const groups = groupByWorkspace(
      [
        summary({ id: 'a1', updatedAt: 500, effectiveWorkspace: 'C:\\work\\alpha' }),
        summary({ id: petId, updatedAt: 900, effectiveWorkspace: 'C:\\work\\alpha' }),
      ],
      petId,
    );
    expect(groups.map((g) => g.key)).toEqual([PET_GROUP_KEY, 'C:\\work\\alpha']);
    expect(groups[0]?.pet).toBe(true);
    expect(groups[0]?.label).toBe('桌宠');
    expect(groups[1]?.rest.map((s) => s.id)).toEqual(['a1']);
    expect(groups[1]?.rest.some((s) => s.id === petId)).toBe(false);
  });

  it('重名工作区用短路径消歧，tooltip 保留完整路径', () => {
    const groups = groupByWorkspace(
      [
        summary({ id: 'x', updatedAt: 200, effectiveWorkspace: 'C:\\one\\shared' }),
        summary({ id: 'y', updatedAt: 100, effectiveWorkspace: 'D:\\two\\shared' }),
      ],
      null,
    );
    expect(groups.map((g) => g.label).sort()).toEqual(['one/shared', 'two/shared']);
    expect(groups.map((g) => g.tooltip).sort()).toEqual([
      'C:\\one\\shared',
      'D:\\two\\shared',
    ]);
  });

  it('空工作区落到明确占位名', () => {
    const groups = groupByWorkspace([summary({ id: 'z', effectiveWorkspace: '' })], null);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(EMPTY_WORKSPACE_LABEL);
    expect(groups[0]?.tooltip).toBe(EMPTY_WORKSPACE_LABEL);
  });
});

describe('needsGeneratedTitle', () => {
  it('有消息且标题未生成时才需要懒生成', () => {
    expect(needsGeneratedTitle(summary({ id: 'a', messageCount: 2 }))).toBe(true);
    expect(needsGeneratedTitle(summary({ id: 'b', messageCount: 2, titleGenerated: true }))).toBe(
      false,
    );
    expect(needsGeneratedTitle(summary({ id: 'c', messageCount: 0 }))).toBe(false);
    expect(needsGeneratedTitle(undefined)).toBe(false);
  });
});
