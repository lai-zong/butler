import { describe, expect, it } from 'vitest';

import { inferReviewVerdict } from '../reviewVerdict.js';

describe('inferReviewVerdict', () => {
  it('明确不通过 → fail', () => {
    expect(inferReviewVerdict('## 审查结论\n\n**不通过**。证据不足。')).toBe('fail');
    expect(inferReviewVerdict('该结果未通过验收。')).toBe('fail');
    expect(inferReviewVerdict('不能原样交付。')).toBe('fail');
  });

  it('明确通过 → pass', () => {
    expect(inferReviewVerdict('## 结论\n\n通过。证据充分。')).toBe('pass');
    expect(inferReviewVerdict('结论：通过（有轻微建议）')).toBe('pass');
    expect(inferReviewVerdict('Review result: pass.')).toBe('pass');
  });

  it('没有明确结论 → unknown', () => {
    expect(inferReviewVerdict('')).toBe('unknown');
    expect(inferReviewVerdict('主要问题是预算数字不一致。')).toBe('unknown');
  });

  it('同时出现肯定和否定时，否定优先', () => {
    expect(inferReviewVerdict('整体通过，但第 3 轮不通过。')).toBe('fail');
  });
});
