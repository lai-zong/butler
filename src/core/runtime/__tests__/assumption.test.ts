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
 *   这与产品目标直接冲突：「自主完成，不要用户逐次审核」。
 *   **不确定 ≠ 不能干**
 *
 *   新行为：照最可能的理解**先干**，把假设说出来，给一条纠正的路。
 *
 * ★ v8（批次C）：置信度来源从**独立的 `route()` 调用**改为**契约自带**。
 *   函数也从 `buildRouteAssumption(confident, decision)` 改名为
 *   `buildAssumption(contract)` —— 它拿的东西变了，名字必须跟着变，
 *   否则读代码的人会以为"还有一层路由"。
 *
 * ⚠️ 一条必须守住的边界：本条**只适用于判断类**。
 *    权限类（删文件、跑命令）不能这样处理 ——
 *    判断错了能改，删掉的文件回不来。
 */

import { describe, expect, it } from 'vitest';

import { buildAssumption } from '../orchestrator.js';

describe('buildAssumption · 低置信度不再阻断', () => {
  it('★ 置信度足够时没有假设（不需要打扰用户）', () => {
    expect(buildAssumption({ domains: ['life'], confidence: 0.9 })).toBeUndefined();
  });

  it('★ 置信度不足时给出假设，且说明「先按什么理解处理了」', () => {
    const a = buildAssumption({ domains: ['health'], confidence: 0.4 });
    expect(a).toBeDefined();
    expect(a?.note).toContain('先按');
    expect(a?.note).toContain('健康');
    expect(a?.confidence).toBe(0.4);
    expect(a?.domains).toEqual(['health']);
  });

  it('★ 有 clarifyingQuestion 时转成「纠正入口」而不是「停下来问」', () => {
    const a = buildAssumption({
      domains: ['life'],
      confidence: 0.3,
      clarifyingQuestion: '你是想让我买菜，还是想让我做菜？',
    });
    expect(a?.note).toContain('你其实是想问');
    expect(a?.wouldHaveAsked).toBe('你是想让我买菜，还是想让我做菜？');
  });

  it('★ 没给 clarifyingQuestion 时仍然给出纠正入口', () => {
    const a = buildAssumption({ domains: ['study'], confidence: 0.2 });
    expect(a?.note).toContain('不对的话直接说');
    expect(a?.wouldHaveAsked).toBeUndefined();
  });

  it('边界：恰好 0.6 视为置信度足够（阈值是「低于」）', () => {
    expect(buildAssumption({ domains: ['code'], confidence: 0.6 })).toBeUndefined();
  });

  it('多领域时全部列出（不再假装只有一个执行者）', () => {
    const a = buildAssumption({ domains: ['life', 'health'], confidence: 0.3 });
    expect(a?.note).toContain('生活');
    expect(a?.note).toContain('健康');
    expect(a?.domains).toHaveLength(2);
  });
});
