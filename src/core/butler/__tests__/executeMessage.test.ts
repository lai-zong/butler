/**
 * 用户消息装配测试（E4 链路的最后一环）
 *
 * ★ 这条链路是：**路由校验 → 服务 → 编排 → 装配 → 转换 → 模型**。
 *   每一环都要有断言，否则"图片到底有没有进模型输入"就只能靠黑盒端到端猜。
 */
import { describe, expect, it } from 'vitest';

import { buildButlerUserMessage } from '../execute.js';
import { toApiMessages } from '../../../adapters/model/convert.js';
import type { TaskContract } from '../contract.js';
import type { InjectedConstraint } from '../../execution/types.js';

const CONTRACT: TaskContract = {
  deliverable: '一份答复',
  criteria: ['能回答问题'],
  mustObey: [],
  domains: [],
  confidence: 0.8,
  raw: { deliverable: '一份答复', criteria: ['能回答问题'], mustObey: [], domains: [], confidence: 0.8 },
} as TaskContract;

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

function build(images?: readonly { url: string; detail?: 'low' | 'high' }[]) {
  return buildButlerUserMessage({
    userGoal: '这张图里是什么？',
    contract: CONTRACT,
    injectedConstraints: [] as readonly InjectedConstraint[],
    ...(images !== undefined ? { images } : {}),
  });
}

describe('buildButlerUserMessage', () => {
  it('无图 → 只有文本片段（保持旧形状）', () => {
    const m = build();
    expect(m.role).toBe('user');
    expect(m.content).toHaveLength(1);
    expect(m.content[0]?.kind).toBe('text');
  });

  it('★★ 有图 → 文本 + 图片片段，且顺序是"先文本后图"', () => {
    const m = build([{ url: IMG, detail: 'high' }]);
    expect(m.role).toBe('user');
    expect(m.content).toHaveLength(2);
    expect(m.content[0]?.kind).toBe('text');
    expect(m.content[1]?.kind).toBe('image');
  });

  it('★ 图片 detail 被带上（读截图文字要 high）', () => {
    const m = build([{ url: IMG, detail: 'high' }]);
    const img = m.content[1];
    expect(img?.kind === 'image' ? img.detail : undefined).toBe('high');
  });

  it('空数组等同无图（不产生空图片片段）', () => {
    const m = build([]);
    expect(m.content).toHaveLength(1);
  });

  it('★★★ 装配结果经 convert 后确实是数组形态（端到端形态对齐）', () => {
    /**
     * 这条串起了两个模块：装配层产出 image 片段，转换层必须把它变成
     * `image_url` 数组 —— 任一侧改坏都会在这里失败。
     */
    const api = toApiMessages([build([{ url: IMG }])]);
    expect(Array.isArray(api[0]?.content)).toBe(true);
    const parts = api[0]?.content;
    if (Array.isArray(parts)) {
      expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    }
  });
});
