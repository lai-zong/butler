/**
 * 记忆分权模型测试 —— 验证权限矩阵。
 *
 * 设计依据：参赛方案 v6.5 § 2.2⑥
 *
 * 这些函数是权限判定的唯一入口。把它们测住，等于把"仆人不能越权"这条
 * 约束钉在类型与逻辑层面，而不是靠调用方自觉。
 */

import { describe, expect, it } from 'vitest';

import {
  isButlerWriteOnly,
  isForceVisible,
  isSearchableByAll,
  participatesInEvolution,
  LIFECYCLE_LABEL,
  MEMORY_CLASS_LABEL,
  type MemoryClass,
} from '../types.js';

const ALL: readonly MemoryClass[] = [
  'global_constraint',
  'global_shared',
  'sensitive',
  'domain',
];

describe('权限矩阵 · 强制可见性', () => {
  it('只有全局硬约束对全部仆人强制可见', () => {
    expect(isForceVisible('global_constraint')).toBe(true);
    for (const c of ALL) {
      if (c !== 'global_constraint') expect(isForceVisible(c), c).toBe(false);
    }
  });
});

describe('权限矩阵 · 可检索性', () => {
  it('全局两层可按需检索，敏感域与领域记忆不可', () => {
    expect(isSearchableByAll('global_constraint')).toBe(true);
    expect(isSearchableByAll('global_shared')).toBe(true);
    // 这两条是"默认隔离"的落点
    expect(isSearchableByAll('sensitive')).toBe(false);
    expect(isSearchableByAll('domain')).toBe(false);
  });
});

describe('权限矩阵 · 写入权（真相源唯一）', () => {
  it('全局硬约束与全局共享只能管家写入', () => {
    expect(isButlerWriteOnly('global_constraint')).toBe(true);
    expect(isButlerWriteOnly('global_shared')).toBe(true);
  });

  it('敏感域也只能管家写入 —— 委托写入会破坏隔离', () => {
    expect(isButlerWriteOnly('sensitive')).toBe(true);
  });

  it('领域记忆由所属仆人自行写入', () => {
    expect(isButlerWriteOnly('domain')).toBe(false);
  });

  it('全局层全部为管家独占写入（仆人无写权限）', () => {
    const butlerOwned = ALL.filter(isButlerWriteOnly);
    expect([...butlerOwned].sort()).toEqual(
      ['global_constraint', 'global_shared', 'sensitive'].sort(),
    );
  });
});

describe('演化参与度 · 硬约束永不淘汰', () => {
  it('全局硬约束不参与衰减与淘汰', () => {
    // 否则会出现"把你的过敏史淘汰掉"这种荒唐结果
    expect(participatesInEvolution('global_constraint')).toBe(false);
  });

  it('其余三类均参与演化', () => {
    expect(participatesInEvolution('global_shared')).toBe(true);
    expect(participatesInEvolution('sensitive')).toBe(true);
    expect(participatesInEvolution('domain')).toBe(true);
  });
});

describe('生命周期 · 淘汰 ≠ 删除', () => {
  it('四态齐备', () => {
    expect(Object.keys(LIFECYCLE_LABEL).sort()).toEqual(
      ['active', 'archived', 'candidate', 'dormant'].sort(),
    );
  });

  it('休眠与归档是独立状态，不是"已删除"', () => {
    // 语义检查：标签里不应出现"删除"字样 —— 淘汰只降权，数据保留
    expect(LIFECYCLE_LABEL.dormant).not.toContain('删除');
    expect(LIFECYCLE_LABEL.archived).not.toContain('删除');
  });

  it('四类记忆都有中文标签', () => {
    for (const c of ALL) expect(MEMORY_CLASS_LABEL[c]).toBeTruthy();
  });
});
