import { describe, expect, it } from 'vitest';

import {
  assessConstraintApplicability,
  domainForFactContent,
  isSoftPreferenceContent,
  isStrongSafetyContent,
  normalizeFactCategory,
} from '../constraintSemantics.js';
import type { ExecutionReport } from '../../execution/types.js';

function report(reply: string, artifacts: ExecutionReport['artifacts'] = []): ExecutionReport {
  return {
    taskId: 't',
    status: 'done',
    reply,
    artifacts,
    memoryRefs: [],
    uncertainties: [],
    findings: [],
  };
}

describe('约束语义归一化（2026-11-17 回归）', () => {
  it('★ 控糖/尽量表达式不是安全硬约束', () => {
    const content = '用户晚上尽量不吃甜的和油炸的食物。';
    expect(isSoftPreferenceContent(content)).toBe(true);
    expect(isStrongSafetyContent(content)).toBe(false);
    expect(normalizeFactCategory('constraint', content)).toBe('preference');
    expect(domainForFactContent(content)).toBe('health');
  });

  it('★ 明确过敏仍是安全硬约束', () => {
    const content = '用户对花生严重过敏。';
    expect(isStrongSafetyContent(content)).toBe(true);
    expect(normalizeFactCategory('preference', content)).toBe('constraint');
  });

  it('★ 明确医嘱/药物禁忌仍是安全硬约束', () => {
    const content = '用户正在服用华法林，医生禁止大量摄入维生素K。';
    expect(isStrongSafetyContent(content)).toBe(true);
    expect(normalizeFactCategory('constraint', content)).toBe('constraint');
  });

  it('普通身份/偏好不被误升级', () => {
    expect(normalizeFactCategory('identity', '用户叫小明。')).toBe('identity');
    expect(normalizeFactCategory('preference', '用户喜欢清淡口味。')).toBe('preference');
  });
});

describe('硬约束适用性三态', () => {
  it('★ 写文件任务不因饮食约束而适用', () => {
    const r = assessConstraintApplicability({
      content: '用户对花生严重过敏。',
      taskGoal: '把 edge-check 写入文件',
      taskDomains: ['code'],
      reports: [report('已写入 edge-check.txt')],
    });
    expect(r.applicability).toBe('not_applicable');
  });

  it('★ 饮食任务适用，且 reply 内容可被识别', () => {
    const r = assessConstraintApplicability({
      content: '用户对花生严重过敏。',
      taskGoal: '今晚想点外卖，给我三个不踩雷的选择',
      taskDomains: ['life'],
      reports: [report('建议清蒸鱼，避开花生和花生油。')],
    });
    expect(r.applicability).toBe('applicable');
  });

  it('★ 旧软偏好即使仍是 global_constraint，也不再适用', () => {
    const r = assessConstraintApplicability({
      content: '用户晚上尽量不吃甜的和油炸的食物。',
      taskGoal: '今晚想点外卖',
      taskDomains: ['life'],
      reports: [report('推荐炸鸡和甜点。')],
    });
    expect(r.applicability).toBe('not_applicable');
  });

  it('没有任务/产出文本 → unknown，不直接判违反', () => {
    const r = assessConstraintApplicability({
      content: '用户对花生严重过敏。',
      taskGoal: '',
      taskDomains: [],
      reports: [],
    });
    expect(r.applicability).toBe('unknown');
  });
});
