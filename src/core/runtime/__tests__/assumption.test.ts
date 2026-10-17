/**
 * 低置信度处理测试 —— 锁住 v7 · D-4 的行为改变
 *
 * ★★ 这个文件防的是一个**产品级倒退**：
 *
 *   旧实现（v7 之前）：
 *     if (!confident) return { steps: [], reports: [] };   // 什么都不干
 *     回复：「置信度不足，已转入澄清提问，未执行派发。」
 *
 *   用户实测撞到过这个 —— 去忙别的回来一看，**什么都没做**。
 *
 *   这与产品目标直接冲突：「自主完成，不要用户逐次审核」。
 *   **不确定 ≠ 不能干** —— 路由本来就已给出最可能的判断。
 *
 *   新行为：照最可能的理解**先干**，把假设说出来，给一条纠正的路。
 *
 * ⚠️ 一条必须守住的边界：本条**只适用于判断类**。
 *    权限类（删文件、跑命令）不能这样处理 ——
 *    判断错了能改，删掉的文件回不来。
 */

import { describe, expect, it } from 'vitest';

import { buildRouteAssumption } from '../orchestrator.js';

describe('buildRouteAssumption · 低置信度不再阻断', () => {
  it('★ 置信度足够时没有假设（不需要打扰用户）', () => {
    expect(
      buildRouteAssumption(true, { servant: 'life', confidence: 0.9 }),
    ).toBeUndefined();
  });

  it('★★ 置信度不足时给出假设（而不是"不干活"）', () => {
    const a = buildRouteAssumption(false, { servant: 'health', confidence: 0.4 });
    expect(a).toBeDefined();
    expect(a?.servant).toBe('health');
    expect(a?.confidence).toBe(0.4);
  });

  it('★★ 假设里必须**先说干了什么**（让用户知道不是什么都没做）', () => {
    const a = buildRouteAssumption(false, { servant: 'life', confidence: 0.3 });
    expect(a?.note).toContain('先按');
    expect(a?.note).toContain('life');
    expect(a?.note).toContain('处理了');
  });

  it('★★ 措辞不含内部术语（用户不关心我们的概率）', () => {
    const a = buildRouteAssumption(false, { servant: 'life', confidence: 0.35 });
    // 不出现置信度数字
    expect(a?.note).not.toContain('0.35');
    expect(a?.note).not.toContain('置信度');
    // 不出现内部英文标识
    expect(a?.note).not.toContain('confidence');
  });

  it('★ 有 clarifyingQuestion 时把它转成"纠正入口"，而不是反问', () => {
    const a = buildRouteAssumption(false, {
      servant: 'life',
      confidence: 0.4,
      clarifyingQuestion: '你是想安排晚饭还是想买菜？',
    });
    expect(a?.note).toContain('你是想安排晚饭还是想买菜？');
    // 关键：给的是"说一声我重来"，不是把球踢回去让用户先回答
    expect(a?.note).toContain('重来');
  });

  it('没有 clarifyingQuestion 时也给纠正入口', () => {
    const a = buildRouteAssumption(false, { servant: 'study', confidence: 0.2 });
    expect(a?.note).toContain('重来');
  });

  it('clarifyingQuestion 是空白串时按"没有"处理', () => {
    const a = buildRouteAssumption(false, {
      servant: 'study',
      confidence: 0.2,
      clarifyingQuestion: '   ',
    });
    expect(a?.note).not.toContain('你其实是想问');
  });

  it('★ 边界：confidence 恰好等于阈值时（调用方判 true）不触发', () => {
    expect(
      buildRouteAssumption(true, { servant: 'life', confidence: 0.6 }),
    ).toBeUndefined();
  });
});
