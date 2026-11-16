import { describe, expect, it } from 'vitest';
import { isPracticeRequest } from '../intent.js';

describe('isPracticeRequest', () => {
  it('识别明确出题请求', () => {
    for (const text of [
      '请只出 1 道 2+2 的选择题，四个选项，不要解释。',
      '帮我出 3 道线性代数题：一道选择、一道简答。',
      '给我来一套练习',
      '出题',
      '来几道题',
      'generate 3 practice questions',
      'quiz me',
    ]) {
      expect(isPracticeRequest(text), text).toBe(true);
    }
  });

  it('不误伤普通问答', () => {
    for (const text of [
      '这道题怎么做？',
      '帮我做这道题',
      '解释一下特征值',
      '帮我复习线性代数',
      '今天适合做什么？',
      '你好',
    ]) {
      expect(isPracticeRequest(text), text).toBe(false);
    }
  });
});
