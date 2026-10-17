/**
 * 思考模式参数的测试 —— 锁住一个**实测到的真实故障**
 *
 * ★★ 这个文件存在的理由：
 *
 *   `deepseek-flash` 是默认模型，而它**默认开启思考模式**（effort=high）。
 *   思考产生的内容**计入 `max_tokens`**，于是结构化调用会这样失败：
 *
 *     maxOutputTokens=1024 → 思考吃掉大半预算
 *     → 产出的 JSON 在中途断掉 → 解析失败
 *     → 重试 3 次仍断（每轮思考都会再吃一次）→ **整个任务失败**
 *
 *   实测复现：`validate:1` 在 `decompose`（1024 token）处报
 *   「结构化输出重试 3 次后仍被长度上限截断」。
 *
 *   ★ 修法：结构化调用**默认关思考**（`applyThinking(body, call, 'disabled')`）。
 *     这个测试就是防止有人把它改回去 —— 那会静默重现代码截断。
 *
 * ⚠️ 另一条官方限制也在这里锁住：
 *   思考模式下 `temperature` **不生效且不报错**。
 *   所以开思考时我们调的 temperature 是白设的。
 */

import { describe, expect, it } from 'vitest';

import { applyThinking } from '../deepseek.js';

describe('applyThinking · 思考模式开关', () => {
  it('★★ 结构化调用默认关思考（防止 JSON 被思考吃掉预算）', () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, {}, 'disabled');
    expect(body['thinking']).toEqual({ type: 'disabled' });
  });

  it('不传 fallback 时默认开启（叙述路径要看得到思考）', () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, {});
    expect(body['thinking']).toEqual({ type: 'enabled' });
  });

  it('★ 调用方显式指定时，显式值优先于 fallback', () => {
    const b1: Record<string, unknown> = {};
    applyThinking(b1, { thinking: 'enabled' }, 'disabled');
    expect(b1['thinking']).toEqual({ type: 'enabled' });

    const b2: Record<string, unknown> = {};
    applyThinking(b2, { thinking: 'disabled' }, 'enabled');
    expect(b2['thinking']).toEqual({ type: 'disabled' });
  });

  it('reasoningEffort 只在显式给出时写入', () => {
    const b1: Record<string, unknown> = {};
    applyThinking(b1, {});
    expect('reasoning_effort' in b1).toBe(false);

    const b2: Record<string, unknown> = {};
    applyThinking(b2, { reasoningEffort: 'low' });
    expect(b2['reasoning_effort']).toBe('low');

    const b3: Record<string, unknown> = {};
    applyThinking(b3, { reasoningEffort: 'max' });
    expect(b3['reasoning_effort']).toBe('max');
  });

  it('不改动 body 里的其它字段', () => {
    const body: Record<string, unknown> = { model: 'deepseek-flash', max_tokens: 1024 };
    applyThinking(body, {});
    expect(body['model']).toBe('deepseek-flash');
    expect(body['max_tokens']).toBe(1024);
  });
});
