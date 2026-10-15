/**
 * 硬约束机械校验测试
 *
 * 这些测试锁住一条设计原则：**硬约束的判定必须是确定性代码，不能交给模型。**
 *
 * 回归背景（验证 1 实测）：场景是"花生严重过敏"，
 * health 仆人正确识别了交叉污染风险，却把 severity 判成 `info`，
 * 导致管家只提示不拦截。这正是"把安全判定交给 LLM"的失败模式。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import type { ScoredMemory } from '../../memory/recall.js';
import type { MemoryEntry } from '../../memory/types.js';
import { coreOf } from '../../text/keywords.js';
import { extractKeywords, verifyHardConstraints } from '../hardConstraints.js';
import type { ServantReport } from '../../servants/types.js';

// ── 测试夹具 ──

const T = 1_760_000_000_000;

function constraint(content: string, id = 'm_hard'): ScoredMemory {
  const memory: MemoryEntry = {
    id,
    owner: { kind: 'butler', userId: 'u' },
    memClass: 'global_constraint',
    kind: 'fact',
    content,
    confidence: 0.98,
    evidence: [],
    fitness: 0.98,
    lifecycle: 'active',
    lastHitAt: T,
    hitCount: 1,
    revivedCount: 0,
    scope: 'global',
    version: 1,
    createdAt: T,
    updatedAt: T,
    useCount: 1,
  };
  // ⚠️ ScoredMemory 的完整形状（原先只给两个字段，是因为旧类型只要求两个）
  return {
    memory,
    relevance: 0.95,
    score: 0.95,
    fitness: memory.fitness,
    confidence: memory.confidence,
    exploratory: false,
    why: '测试夹具',
  };
}

function report(
  servant: ServantReport['servant'],
  opts: {
    artifacts?: string[];
    findings?: ServantReport['findings'];
    status?: ServantReport['status'];
  } = {},
): ServantReport {
  return {
    taskId: `t_${servant}`,
    servant,
    status: opts.status ?? 'done',
    artifacts: (opts.artifacts ?? []).map((c) => ({ kind: 'text' as const, content: c })),
    memoryRefs: [],
    uncertainties: [],
    findings: opts.findings ?? [],
  };
}

// ═══════════════════════════════════════════════════════════

describe('coreOf / extractKeywords · 约束核心串提取', () => {
  it('剥离虚词与标点，得到核心字串', () => {
    expect(coreOf('你对花生严重过敏')).toBe('花生过敏');
    expect(coreOf('你正在服用华法林，忌维生素K')).toContain('维生素K');
  });

  it('核心串里不再含虚词', () => {
    expect(coreOf('你对花生严重过敏')).not.toContain('你对');
    expect(coreOf('你对花生严重过敏')).not.toContain('严重');
  });

  it('提不出实词时返回空（不误伤）', () => {
    expect(coreOf('的的的')).toBe('');
    expect(extractKeywords('的的的')).toEqual([]);
  });

  it('候选片段包含长度≥2的连续子串', () => {
    const k = extractKeywords('你对花生严重过敏');
    expect(k).toContain('花生');
    expect(k).toContain('过敏');
    expect(k).toContain('花生过敏');
  });
});

describe('verifyHardConstraints · 未处理时机械拦截', () => {
  it('仆人产出完全没提过敏 → 拦截', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [report('life', { artifacts: ['推荐了川味火锅，评分很高'] })],
      now: T,
    });

    expect(result.mustBlock).toBe(true);
    expect(result.verdicts[0]?.satisfied).toBe(false);
    expect(result.verdicts[0]?.unhandledBy).toEqual(['life']);
    // 关键：写入了拦截事件，且标注为确定性判定
    const blocked = log.byType('constraint.hardBlocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ deterministic: true });
  });

  it('仆人产出提到过敏 → 通过', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [
        report('life', { artifacts: ['菜单全程排除花生及花生制品，提示核对配料表'] }),
      ],
      now: T,
    });

    expect(result.mustBlock).toBe(false);
    expect(log.byType('constraint.hardBlocked')).toHaveLength(0);
  });

  it('仆人提交了指向该约束的 finding → 通过（即使产出物没提）', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [
        report('health', {
          artifacts: ['约束清单如下'],
          findings: [
            { kind: 'constraintRef', statement: '本清单已按花生过敏约束执行', evidence: [] },
          ],
        }),
      ],
      now: T,
    });

    expect(result.mustBlock).toBe(false);
  });

  it('多个仆人中有任意一个未处理 → 拦截，并指名是谁', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [
        report('life', { artifacts: ['菜单排除花生'] }),
        report('work', { artifacts: ['时间安排：周六 18:00 开饭'] }),
      ],
      now: T,
    });

    expect(result.mustBlock).toBe(true);
    expect(result.verdicts[0]?.unhandledBy).toEqual(['work']);
  });

  it('失败的仆人不计为未处理（它没有产出）', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [
        report('life', { artifacts: ['排除花生'] }),
        report('code', { status: 'failed' }),
      ],
      now: T,
    });

    expect(result.mustBlock).toBe(false);
  });
});

describe('verifyHardConstraints · 多条约束独立判定', () => {
  it('只拦截未满足的那条', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [
        constraint('你对花生严重过敏', 'm_peanut'),
        constraint('你正在服用华法林，忌维生素K', 'm_warfarin'),
      ],
      reports: [report('life', { artifacts: ['菜单已排除花生与花生油'] })],
      now: T,
    });

    const peanut = result.verdicts.find((v) => v.constraintId === 'm_peanut');
    const warfarin = result.verdicts.find((v) => v.constraintId === 'm_warfarin');
    expect(peanut?.satisfied).toBe(true);
    expect(warfarin?.satisfied).toBe(false);
    expect(result.mustBlock).toBe(true);
    expect(log.byType('constraint.hardBlocked')).toHaveLength(1);
  });
});

describe('verifyHardConstraints · 边界', () => {
  it('没有硬约束时不拦截', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [],
      reports: [report('life', { artifacts: ['随便什么'] })],
      now: T,
    });
    expect(result.mustBlock).toBe(false);
    expect(result.verdicts).toHaveLength(0);
  });

  it('没有仆人产出时不误报', () => {
    const log = new EventLog('s');
    const result = verifyHardConstraints({
      log,
      hardConstraints: [constraint('你对花生严重过敏')],
      reports: [],
      now: T,
    });
    expect(result.mustBlock).toBe(false);
  });
});
