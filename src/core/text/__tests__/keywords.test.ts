/**
 * 文本相关性判定测试
 *
 * 两个用途共用这套逻辑：
 *   ① 硬约束校验：产出有没有处理某条约束
 *   ② 约束注入筛选：这条约束与本次子任务是否相关
 *
 * ②的动机是双重的：**既省 token，也更符合方案原话**
 * （§ 2.2⑥："仆人只拿到本次任务相关的约束，不是全部记忆"）。
 * 实测中发现把"3 公里内的餐厅"注入给"时间安排"步骤纯属噪声。
 */

import { describe, expect, it } from 'vitest';

import { coreOf, hasAnyNgram, isRelevant } from '../keywords.js';

describe('coreOf · 剥离虚词', () => {
  it('去掉人称与程度副词', () => {
    expect(coreOf('你对花生严重过敏')).toBe('花生过敏');
  });

  it('去掉标点，保留实词', () => {
    expect(coreOf('你正在服用华法林，忌维生素K')).toContain('华法林');
    expect(coreOf('你正在服用华法林，忌维生素K')).toContain('维生素K');
  });

  it('纯虚词返回空串', () => {
    expect(coreOf('的的的')).toBe('');
  });
});

describe('hasAnyNgram · 片段命中', () => {
  it('长片段命中', () => {
    expect(hasAnyNgram('这份菜单已排除花生及花生油', '花生过敏', 2)).toBe(true);
  });

  it('完全无关时返回 false', () => {
    expect(hasAnyNgram('周六 18:00 开饭', '花生过敏', 2)).toBe(false);
  });

  it('长度不足 minLen 时不命中', () => {
    expect(hasAnyNgram('花生', '花生', 3)).toBe(false);
  });
});

describe('isRelevant · 双向判定', () => {
  it('约束与子任务谈同一概念 → 相关', () => {
    expect(isRelevant('设计一份无花生的家宴菜单', '你对花生严重过敏')).toBe(true);
  });

  it('减脂约束与饮食类子任务 → 相关', () => {
    expect(isRelevant('给出饮食约束清单，含油盐控制', '你正在减脂期，需控制高油高盐')).toBe(true);
  });

  it('★ 餐厅距离约束与时间安排子任务 → 不相关（这条是省 token 的关键）', () => {
    expect(
      isRelevant('把家宴安排落到具体时间：确定周末哪天、几点开饭', '你偏好离家 3 公里内的餐厅'),
    ).toBe(false);
  });

  it('素食约束与时间安排子任务 → 不相关', () => {
    expect(isRelevant('生成一份采购与备菜的时间表', '小李是你的朋友，素食者')).toBe(false);
  });

  it('提不出实词时保守返回 true（宁可多注入）', () => {
    expect(isRelevant('随便写点什么', '的的的')).toBe(true);
    expect(isRelevant('的的的', '花生过敏')).toBe(true);
  });
});
