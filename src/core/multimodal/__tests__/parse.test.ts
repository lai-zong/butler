/**
 * 附件解析测试（E1 · `parseAttachment`）
 *
 * ★ 这个文件补的是**此前根本不存在的函数**：
 *   `ParsedAttachment` / `extractMemoryCandidates` 早就写好了，
 *   但没有任何东西产出 `ParsedAttachment` —— 所以多模态进记忆一直是断的。
 *
 * 重点验三件事：
 *   ① **不支持视觉时必须在调模型之前拒绝**（否则会无声降级）
 *   ② 解析结果能直接喂给 `extractMemoryCandidates` 产出候选
 *   ③ 失败**不抛异常**，返回可读原因
 */
import { describe, expect, it, vi } from 'vitest';

import { MAX_INLINE_TEXT_CHARS, parseAttachment } from '../parse.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelPort } from '../../ports/model.js';

const T0 = 1_760_000_000_000;

function setup(opts?: { vision?: boolean; output?: unknown; throws?: boolean }) {
  const log = new EventLog('s_parse');
  const clock = new FixedClock(T0);

  const completeStructured = vi.fn(async () => {
    if (opts?.throws === true) throw new Error('模型超时');
    return {
      value:
        opts?.output ?? {
          fields: { 品牌: '星巴克', 金额: '38.00', 日期: '2026-10-18' },
          summary: '一张咖啡店小票',
        },
      usage: { inputTokens: 100, outputTokens: 30 },
      attempts: 1,
    };
  });

  const model = {
    describe: () => ({
      provider: 'deepseek',
      model: 'deepseek-flash',
      capabilities: {
        supportsVision: opts?.vision ?? true,
        supportsStreaming: false,
        supportsTools: false,
        separatesThinking: false,
      },
    }),
    completeStructured,
    complete: async () => {
      throw new Error('不应调用 complete');
    },
  } as unknown as ModelPort;

  return { log, clock, model, completeStructured };
}

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

describe('★★★ 能力检查必须在调模型之前', () => {
  it('★★ 模型不支持读图 → 直接拒绝，**一次模型调用都没有**', async () => {
    /**
     * ⚠️ 这条是硬约束：实测 `deepseek-v4-pro` 收到图片**不报错**，
     *    HTTP 200，只在正文里回一句"抱歉，我无法查看这张图片"。
     *    不先查能力就会把"没看到图"当成"解析成功"。
     */
    const { log, clock, model, completeStructured } = setup({ vision: false });
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'r.png',
      source: { kind: 'image', url: IMG },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不支持读图');
    expect(completeStructured).not.toHaveBeenCalled();
  });
});

describe('★★ 正常解析', () => {
  it('★ 图片 → 结构化字段 + 摘要 + 模型标识 + usage', async () => {
    const { log, clock, model } = setup();
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'r.png',
      source: { kind: 'image', url: IMG },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.fields['品牌']).toBe('星巴克');
      expect(r.parsed.summary).toContain('小票');
      expect(r.parsed.model).toBe('deepseek-flash');
      expect(r.parsed.usage.inputTokens).toBe(100);
    }
  });

  it('★★ 解析结果能直接产出记忆候选（多模态进记忆的那一环）', async () => {
    const { log, clock, model } = setup();
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'r.png',
      source: { kind: 'image', url: IMG },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 品牌 → 偏好；金额 → 事实；日期 → 事实
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
      expect(r.candidates.some((c) => c.content.includes('星巴克'))).toBe(true);
      // ★ 置信度必须偏低（推断证据弱于用户直说）
      expect(r.candidates.every((c) => c.confidence <= 0.7)).toBe(true);
    }
  });

  it('★ 文本附件走内联，不要求视觉能力', async () => {
    const { log, clock, model, completeStructured } = setup({ vision: false });
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a2',
      kind: 'document',
      fileName: 'note.txt',
      source: { kind: 'text', text: '今天买了星巴克，38 元' },
    });

    expect(r.ok).toBe(true);
    expect(completeStructured).toHaveBeenCalledTimes(1);
  });

  it('★ 超长文本被截断（不让一次解析吃掉整个上下文）', async () => {
    const { log, clock, model, completeStructured } = setup();
    const long = 'x'.repeat(MAX_INLINE_TEXT_CHARS + 5000);
    await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a3',
      kind: 'document',
      fileName: 'big.txt',
      source: { kind: 'text', text: long },
    });

    // ⚠️ `vi.fn()` 的入参类型是空元组，取值要走 unknown 再收窄
    const calls = completeStructured.mock.calls as unknown as Array<
      [{ messages: readonly { content: unknown }[] }]
    >;
    const dumped = JSON.stringify(calls[0]?.[0].messages);
    expect(dumped.length).toBeLessThan(MAX_INLINE_TEXT_CHARS + 3000);
  });
});

describe('★★ 失败不抛异常，返回可读原因', () => {
  it('模型抛错 → ok:false + 原因', async () => {
    const { log, clock, model } = setup({ throws: true });
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'r.png',
      source: { kind: 'image', url: IMG },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('模型超时');
  });

  it('空文本 → 直接拒绝，不调模型', async () => {
    const { log, clock, model, completeStructured } = setup();
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'document',
      fileName: 'empty.txt',
      source: { kind: 'text', text: '   ' },
    });
    expect(r.ok).toBe(false);
    expect(completeStructured).not.toHaveBeenCalled();
  });
});

describe('★ 留痕：只记元信息，不记原始内容', () => {
  it('解析成功会落 attachment.parsed 事件，且不含附件正文', async () => {
    const { log, clock, model } = setup();
    await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'r.png',
      source: { kind: 'image', url: IMG },
    });

    const events = log.byType('attachment.parsed');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['fieldCount']).toBe(3);
    // ⚠️ 隐私：不得把字段值或摘要正文写进事件
    const dumped = JSON.stringify(payload);
    expect(dumped).not.toContain('星巴克');
    expect(dumped).not.toContain('小票');
  });
});
