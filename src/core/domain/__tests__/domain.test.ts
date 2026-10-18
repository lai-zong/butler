/**
 * 领域标签测试 —— 锁住「管家+仆人 → 管家+监督员」改造的第一件事
 *
 * 核心要回答：为什么需要这个模块？它和旧的 `DomainId` 差在哪？
 *   · ① 领域划分本身保留（生活/健康/学习/办公/代码）
 *   · ② 领域纪律 **27 条一字不删**（那是全项目最有价值的提示词资产）
 *   · ③ 但"路由判据"（test）**必须删掉** —— 路由已砍（D-3）
 *   · ④ 用途从"仆人执行约束"变成"监督员复核标准"
 *   · ⑤ `inferDomains` 只打标签，**不猜**：判不出就返回空
 */

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_DISCIPLINE,
  DOMAIN_IDS,
  DOMAIN_INFO,
  domainName,
  inferDomains,
  isDomainId,
  type DomainId,
} from '../types.js';

describe('① 领域划分保留', () => {
  it('五个领域，顺序固定（防界面标签乱跳）', () => {
    expect(DOMAIN_IDS).toEqual(['life', 'health', 'study', 'work', 'code']);
  });

  it('每个领域都有名称与描述', () => {
    for (const id of DOMAIN_IDS) {
      expect(DOMAIN_INFO[id].name.length).toBeGreaterThan(0);
      expect(DOMAIN_INFO[id].domain.length).toBeGreaterThan(0);
    }
  });

  it('★ 领域信息里**没有** test 字段（路由判据已随 D-3 删除）', () => {
    for (const id of DOMAIN_IDS) {
      expect('test' in DOMAIN_INFO[id]).toBe(false);
    }
  });
});

describe('② 领域纪律 27 条一字不删', () => {
  it('总量必须是 27 条（5+6+5+5+6）', () => {
    // ⚠️ 我一开始写成「30 条」—— 那是算术错（5+6+5+5+6 = 27）。
    //    这个断言就是为了防止"凭印象说条数"。
    const total = DOMAIN_IDS.reduce((s, id) => s + DOMAIN_DISCIPLINE[id].length, 0);
    expect(total).toBe(27);
  });

  it('各领域条数正确', () => {
    expect(DOMAIN_DISCIPLINE.life).toHaveLength(5);
    expect(DOMAIN_DISCIPLINE.health).toHaveLength(6);
    expect(DOMAIN_DISCIPLINE.study).toHaveLength(5);
    expect(DOMAIN_DISCIPLINE.work).toHaveLength(5);
    expect(DOMAIN_DISCIPLINE.code).toHaveLength(6);
  });

  it('★ 抽查三条最有价值的具体标准（措辞必须原样）', () => {
    expect(DOMAIN_DISCIPLINE.health).toContain(
      '给出**量化区间**而不是形容词（"油 ≤ 5g/人/餐"，不是"少油"）',
    );
    expect(DOMAIN_DISCIPLINE.study).toContain(
      '注意遗忘曲线：同一主题安排复习节点，而不是一次讲完',
    );
    expect(DOMAIN_DISCIPLINE.work).toContain(
      '文档结构：结论先行 → 依据 → 待决事项，避免流水账',
    );
  });

  it('没有空条目（空的纪律等于没有纪律）', () => {
    for (const id of DOMAIN_IDS) {
      for (const d of DOMAIN_DISCIPLINE[id]) {
        expect(d.trim().length).toBeGreaterThan(4);
      }
    }
  });
});

describe('③ 小工具', () => {
  it('domainName 给中文名', () => {
    expect(domainName('health')).toBe('健康');
    expect(domainName('code')).toBe('代码');
  });

  it('未知值原样返回（界面不显示空白）', () => {
    expect(domainName('unknown')).toBe('unknown');
  });

  it('isDomainId 校验外部输入', () => {
    expect(isDomainId('life')).toBe(true);
    expect(isDomainId('nope')).toBe(false);
    expect(isDomainId(undefined)).toBe(false);
    expect(isDomainId(123)).toBe(false);
  });
});

describe('④ inferDomains · 只打标签，不猜', () => {
  it('健康相关', () => {
    expect(inferDomains('我对花生过敏，最近在减脂')).toContain<DomainId>('health');
  });

  it('生活相关', () => {
    expect(inferDomains('帮我在超市买点菜，看看冰箱还有什么')).toContain<DomainId>('life');
  });

  it('代码相关（英文也认）', () => {
    expect(inferDomains('这段代码报错了，帮我 debug')).toContain<DomainId>('code');
  });

  it('★ 跨领域能同时识别多个', () => {
    const d = inferDomains('帮我用代码写个脚本，计算每日营养摄入');
    expect(d).toContain<DomainId>('code');
    expect(d).toContain<DomainId>('health');
    expect(d.length).toBeGreaterThanOrEqual(2);
  });

  it('★ 判不出就返回空（不硬塞一个领域）', () => {
    expect(inferDomains('嗯')).toEqual([]);
    expect(inferDomains('今天天气怎么样')).toEqual([]);
  });

  it('返回顺序稳定（与 DOMAIN_IDS 同序，防界面乱跳）', () => {
    const d = inferDomains('过敏 买菜 学习 文档 代码');
    const expected = DOMAIN_IDS.filter((id) => d.includes(id));
    expect(d).toEqual(expected);
  });

  it('不重复返回同一领域', () => {
    const d = inferDomains('过敏，过敏，还是很过敏');
    expect(d.filter((x) => x === 'health')).toHaveLength(1);
  });
});
