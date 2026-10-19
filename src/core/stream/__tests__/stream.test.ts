/**
 * 流式推理与增量翻译测试
 *
 * ★ 三组主张：
 *   ① ★★ **增量**翻译 —— 第一句到边界即开始译，不是等整段
 *   ② **不阻塞、不丢内容** —— 翻译失败回退原文；流中断保留已生成内容
 *   ③ 句边界切分正确（英文句点不误切小数与省略号）
 */

import { describe, expect, it, vi } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelStreamChunk, ModelStreamPort } from '../../ports/stream.js';
import {
  FORCE_SPLIT_CHARS,
  createSegmenter,
} from '../types.js';
import {
  IncrementalTranslator,
  OrderBuffer,
  looksEnglish,
  type TranslationPort,
} from '../translate.js';
import { MAX_DELTA_EVENTS, runReasoningStream, collectChunks } from '../runner.js';
import { createSseParser, mapFinishReason } from '../../../adapters/model/deepseekStream.js';

const T0 = 1_760_000_000_000;

function setup() {
  const log = new EventLog('s_stream');
  const clock = new FixedClock(T0);
  return { log, clock };
}

/** 假翻译器：把每句包成「中:...」，并可控制延迟与失败。 */
class FakeTranslator implements TranslationPort {
  readonly calls: string[] = [];
  constructor(
    private readonly opts: {
      readonly delayMs?: number;
      readonly failOn?: (text: string) => boolean;
      /** 让某句比别人慢，用于测保序 */
      readonly slowOn?: (text: string) => number;
    } = {},
  ) {}

  async translate(text: string): Promise<string> {
    this.calls.push(text);
    const delay = this.opts.slowOn?.(text) ?? this.opts.delayMs ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (this.opts.failOn?.(text) === true) throw new Error('翻译服务不可用');
    return `中:${text}`;
  }
}

/** 从分片数组造一个流端口。 */
function portOf(chunks: readonly ModelStreamChunk[]): ModelStreamPort {
  return {
        async *stream() {
      for (const c of chunks) yield c;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ① 句边界切分
// ═══════════════════════════════════════════════════════════

describe('① 句边界切分', () => {
  it('按句末标点切分', () => {
    const s = createSegmenter();
    const out = s.push('Hello world. This is a test. And more');
    expect(out).toEqual(['Hello world.', 'This is a test.']);
    expect(s.pending()).toBe(' And more');
  });

  it('★ 增量到达也能正确切分（跨分片的句子）', () => {
    const s = createSegmenter();
    expect(s.push('Hello wor')).toEqual([]);
    expect(s.push('ld. Next')).toEqual(['Hello world.']);
    expect(s.push(' one.')).toEqual(['Next one.']);
  });

  it('★★ 英文句点不误切小数', () => {
    const s = createSegmenter();
    const out = s.push('The value is 3.14 and pi is 3.14159. Done.');
    expect(out).toEqual(['The value is 3.14 and pi is 3.14159.', 'Done.']);
  });

  it('★★ 省略号不被当成三个句末', () => {
    const s = createSegmenter();
    const out = s.push('Well... that is odd. Really.');
    expect(out).toEqual(['Well... that is odd.', 'Really.']);
  });

  it('中文标点同样切分', () => {
    const s = createSegmenter();
    const out = s.push('第一句。第二句！第三句？');
    expect(out).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('★★ 无标点时按长度强制切分（否则翻译会被一直卡住）', () => {
    const s = createSegmenter({ forceSplitChars: 30, minForceSplit: 20 });
    const long = 'word '.repeat(20); // 100 字符，无句末标点
    const out = s.push(long);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.length).toBeLessThanOrEqual(50);
  });

  it('强制切分优先在空白处断（不切断单词）', () => {
    const s = createSegmenter({ forceSplitChars: 20, minForceSplit: 10 });
    const src = 'alpha beta gamma delta epsilon zeta';
    const out = s.push(src);
    const first = out[0];
    expect(first).toBeDefined();

    // ⚠️ 判据用"原串里紧随其后的字符是空白"，
    //    而不是"末字符不是 1—2 个字母" —— 后者会误判 epsilon 这类
    //    以短音节结尾的**完整**单词（实测踩过）。
    const endIdx = first!.length;
    expect(endIdx).toBeLessThan(src.length);
    expect(/\s/.test(src[endIdx] ?? '')).toBe(true);
  });

  it('flush 取出残余', () => {
    const s = createSegmenter();
    s.push('Incomplete thought');
    expect(s.flush()).toBe('Incomplete thought');
    // flush 后缓冲清空
    expect(s.pending()).toBe('');
  });

  it('空输入不产生句子', () => {
    const s = createSegmenter();
    expect(s.push('')).toEqual([]);
    expect(s.flush()).toBe('');
  });

  it('默认强制切分长度符合方案（40—60）', () => {
    expect(FORCE_SPLIT_CHARS).toBeGreaterThanOrEqual(40);
    expect(FORCE_SPLIT_CHARS).toBeLessThanOrEqual(60);
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★★ 增量翻译（核心主张）
// ═══════════════════════════════════════════════════════════

describe('② ★★ 增量翻译 —— 第一句到边界即开始译', () => {
  it('★★ 不是等整段：第一句成句就发起翻译', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const seen: string[] = [];

    const t = new IncrementalTranslator({
      port,
      clock,
      onTranslated: ({ translated }) => seen.push(translated),
    });

    // 只喂第一句
    t.feed('First sentence. ');
    // ⚠️ 不等 done —— 翻译应当**已经**开始了
    await Promise.resolve();
    expect(port.calls).toContain('First sentence.');

    // 再喂第二句
    t.feed('Second sentence. ');
    await t.done();

    expect(port.calls).toContain('Second sentence.');
    expect(seen).toHaveLength(2);
  });

  it('★ feed 不阻塞（收流不该被翻译拖慢）', () => {
    const { clock } = setup();
    let resolveFn: (() => void) | undefined;
    const slow: TranslationPort = {
      translate: () =>
        new Promise<string>((r) => {
          resolveFn = () => r('中');
        }),
    };

    const t = new IncrementalTranslator({ port: slow, clock, onTranslated: () => undefined });

    const before = Date.now();
    t.feed('Sentence one. Sentence two. Sentence three. ');
    const elapsed = Date.now() - before;

    // 同步返回，不等翻译
    expect(elapsed).toBeLessThan(50);
    expect(t.inFlight()).toBe(3);
    resolveFn?.();
  });

  it('★★ 残余的不成句内容在 done 时也译（否则最后一句永远没中文）', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const t = new IncrementalTranslator({ port, clock, onTranslated: () => undefined });

    t.feed('Complete sentence. And a trailing fragment');
    await t.done();

    expect(port.calls).toContain('And a trailing fragment');
  });

  it('★ 中文内容被跳过（不白花 token 也不破坏原文）', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const got: string[] = [];
    const t = new IncrementalTranslator({
      port,
      clock,
      onTranslated: ({ translated }) => got.push(translated),
    });

    t.feed('这是一段中文思考。不应该被翻译。');
    const stats = await t.done();

    expect(port.calls).toHaveLength(0);
    expect(stats.skipped).toBeGreaterThan(0);
    // 但回调仍要触发 —— 否则调用方会永远等这一句
    expect(got.length).toBeGreaterThan(0);
  });

  it('★★ 翻译失败回退原文并标注，不阻塞', async () => {
    const { clock } = setup();
    const port = new FakeTranslator({ failOn: (t) => t.includes('bad') });
    const got: string[] = [];
    const failures: string[] = [];

    const t = new IncrementalTranslator({
      port,
      clock,
      onTranslated: ({ translated }) => got.push(translated),
      onFailed: ({ source }) => failures.push(source),
    });

    t.feed('This is good. This is bad. This is also good.');
    const stats = await t.done();

    expect(stats.failed).toBe(1);
    expect(stats.succeeded).toBe(2);
    expect(failures).toEqual(['This is bad.']);
    // ★ 兜底内容含原文与标注
    const fellBack = got.find((g) => g.includes('翻译失败'));
    expect(fellBack).toContain('This is bad.');
  });

  it('★ 翻译超时按失败处理，不拖住整条流', async () => {
    const { clock } = setup();
    const hanging: TranslationPort = {
      translate: (_t, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };

    const t = new IncrementalTranslator({
      port: hanging,
      clock,
      onTranslated: () => undefined,
      timeoutMs: 30,
    });

    t.feed('This will hang.');
    const stats = await t.done();
    expect(stats.failed).toBe(1);
  });

  it('统计里记录首句译文延迟（衡量"增量"是否真的有效）', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const t = new IncrementalTranslator({ port, clock, onTranslated: () => undefined });

    t.feed('One. Two. Three.');
    const stats = await t.done();

    expect(stats.firstTranslationMs).not.toBeNull();
    expect(stats.attempted).toBe(3);
  });

  it('可按需关闭翻译（shouldTranslate 返回 false）', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const t = new IncrementalTranslator({
      port,
      clock,
      onTranslated: () => undefined,
      shouldTranslate: () => false,
    });
    t.feed('English sentence. Another one.');
    const stats = await t.done();
    expect(port.calls).toHaveLength(0);
    expect(stats.skipped).toBe(2);
  });

  it('done 之后 feed 不再受理（避免流结束还在译）', async () => {
    const { clock } = setup();
    const port = new FakeTranslator();
    const t = new IncrementalTranslator({ port, clock, onTranslated: () => undefined });
    t.feed('One.');
    await t.done();
    t.feed('Late sentence.');
    expect(port.calls).not.toContain('Late sentence.');
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★★ 保序缓冲（乱序到达也要按原文顺序显示）
// ═══════════════════════════════════════════════════════════

describe('③ ★★ 保序缓冲', () => {
  it('★ 乱序到达按顺序吐出', () => {
    const b = new OrderBuffer<string>();
    expect(b.push(1, 'second')).toEqual([]); // 等 0
    expect(b.push(0, 'first')).toEqual(['first', 'second']);
  });

  it('缺号时后面的不发（否则会乱序）', () => {
    const b = new OrderBuffer<string>();
    b.push(2, 'third');
    b.push(3, 'fourth');
    expect(b.waiting()).toBe(2);
  });

  it('连续入队时逐条吐出', () => {
    const b = new OrderBuffer<string>();
    expect(b.push(0, 'a')).toEqual(['a']);
    expect(b.push(1, 'b')).toEqual(['b']);
  });

  it('同一序号不重复吐出', () => {
    const b = new OrderBuffer<string>();
    expect(b.push(0, 'a')).toEqual(['a']);
    expect(b.push(0, 'a-again')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 推理流编排
// ═══════════════════════════════════════════════════════════

describe('④ 推理流编排', () => {
  const chunks: readonly ModelStreamChunk[] = [
    { kind: 'reasoning', delta: 'Let me think. ' },
    { kind: 'reasoning', delta: 'The answer is 42. ' },
    { kind: 'text', delta: '答案是 ' },
    { kind: 'text', delta: '42。' },
    {
      kind: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 20 },
      model: 'deepseek-chat',
      fullText: '答案是 42。',
      fullReasoning: 'Let me think. The answer is 42. ',
    },
  ];

  it('★ 分开累积思考与回答', async () => {
    const { log, clock } = setup();
    const r = await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });

    expect(r.reasoning).toBe('Let me think. The answer is 42. ');
    expect(r.answer).toBe('答案是 42。');
    expect(r.chunks).toBe(5);
  });

  it('★★ 思考被增量翻译，回答**不**翻译', async () => {
    const { log, clock } = setup();
    const port = new FakeTranslator();
    const updates: { reasoningTranslated: string; answer: string }[] = [];

    const r = await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      translatorPort: port,
      onUpdate: (s) => updates.push({ reasoningTranslated: s.reasoningTranslated, answer: s.answer }),
    });

    expect(r.translation?.succeeded).toBe(2);
    expect(r.reasoningTranslated).toContain('中:Let me think.');
    expect(r.reasoningTranslated).toContain('中:The answer is 42.');
    // 回答保持原样
    expect(r.answer).toBe('答案是 42。');
  });

  it('★ 落 thought.delta 与 thought.done 事件（这两个事件此前是死的）', async () => {
    const { log, clock } = setup();
    await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });

    expect(log.byType('thought.delta').length).toBeGreaterThan(0);
    const done = log.byType('thought.done');
    expect(done).toHaveLength(1);
    const p = done[0]?.payload as Record<string, unknown>;
    // 'Let me think. The answer is 42. ' 实测 32 字符
    expect(p['reasoningLength']).toBe(32);
    expect(p['chunks']).toBe(5);
  });

  it('★ 分片事件被聚合（字符级流式不该逐字符落事件）', async () => {
    const { log, clock } = setup();
    const many: ModelStreamChunk[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ kind: 'text' as const, delta: `c${i}` })),
      {
        kind: 'done' as const,
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm',
        fullText: '',
        fullReasoning: '',
      },
    ];

    await runReasoningStream({
      port: portOf(many),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });

    // 100 个分片不该产生 100 条事件
    expect(log.byType('thought.delta').length).toBeLessThan(100);
  });

  it('★ 分片事件有上限兜底', async () => {
    const { log, clock } = setup();
    // 时间不前进 → 聚合窗口永远不到 → 只在 done 时 flush 一次
    // 用大量切换 kind 来强制多次 flush
    const switching: ModelStreamChunk[] = [];
    for (let i = 0; i < MAX_DELTA_EVENTS + 50; i++) {
      switching.push({ kind: i % 2 === 0 ? 'reasoning' : 'text', delta: `x${i}` });
    }
    switching.push({
      kind: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
      fullText: '',
      fullReasoning: '',
    });

    await runReasoningStream({
      port: portOf(switching),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });

    expect(log.byType('thought.delta').length).toBeLessThanOrEqual(MAX_DELTA_EVENTS + 1);
  });

  it('★ 工具调用分片被拼接', async () => {
    const { log, clock } = setup();
    const r = await runReasoningStream({
      port: portOf([
        // ⚠️ index 是必填 —— 它是工具调用分片唯一稳定的聚合键
        //    （实测：id 与 name 只在一次调用的第一个分片出现）
        { kind: 'toolCall', index: 0, callId: 'c1', name: 'read_file', argsDelta: '{"pa' },
        { kind: 'toolCall', index: 0, callId: 'c1', name: '', argsDelta: 'th":"a.txt"}' },
        {
          kind: 'done',
          finishReason: 'toolCalls',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'm',
          fullText: '',
          fullReasoning: '',
        },
      ]),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });

    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.name).toBe('read_file');
    expect(r.toolCalls[0]?.args).toBe('{"path":"a.txt"}');
  });

  it('★★ 流中断保留已生成内容', async () => {
    const { log, clock } = setup();
    const failing: ModelStreamPort = {
            async *stream() {
        yield { kind: 'reasoning', delta: 'Partial thinking. ' };
        yield { kind: 'text', delta: 'Partial answer' };
        throw new Error('连接中断');
      },
    };

    await expect(
      runReasoningStream({
        port: failing,
        log,
        clock,
        taskId: 't1',
        call: { purpose: 'reasoning', messages: [] },
        onUpdate: () => undefined,
      }),
    ).rejects.toThrow('连接中断');

    // ★ 中断也要落 done 事件，且带上已生成的长度
    const done = log.byType('thought.done');
    expect(done).toHaveLength(1);
    const p = done[0]?.payload as Record<string, unknown>;
    expect(p['interrupted']).toBe(true);
    // 'Partial thinking. ' 实测 18 字符
    expect(p['reasoningLength']).toBe(18);
    expect(p['note']).toContain('已生成内容保留');
  });

  it('中断时 partial 内容可被取回', async () => {
    const { log, clock } = setup();
    const failing: ModelStreamPort = {
            async *stream() {
        yield { kind: 'text', delta: 'kept' };
        throw new Error('boom');
      },
    };

    try {
      await runReasoningStream({
        port: failing,
        log,
        clock,
        taskId: 't1',
        call: { purpose: 'reasoning', messages: [] },
        onUpdate: () => undefined,
      });
      throw new Error('应当抛出');
    } catch (err) {
      const partial = (err as { partial?: { answer: string } }).partial;
      expect(partial?.answer).toBe('kept');
    }
  });

  it('onUpdate 被反复调用（界面据此渲染）', async () => {
    const { log, clock } = setup();
    const onUpdate = vi.fn();
    await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate,
    });
    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(chunks.length);
  });

  it('首字延迟被记录（流式体验的关键指标）', async () => {
    const { log, clock } = setup();
    const r = await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
    });
    expect(r.firstChunkMs).toBeGreaterThanOrEqual(0);
  });

  it('emitEvents=false 时不落事件（供不需要审计的场景）', async () => {
    const { log, clock } = setup();
    await runReasoningStream({
      port: portOf(chunks),
      log,
      clock,
      taskId: 't1',
      call: { purpose: 'reasoning', messages: [] },
      onUpdate: () => undefined,
      emitEvents: false,
    });
    expect(log.byType('thought.delta')).toHaveLength(0);
    expect(log.byType('thought.done')).toHaveLength(0);
  });

  it('collectChunks 工具函数', () => {
    const r = collectChunks(chunks);
    expect(r.reasoning).toBe('Let me think. The answer is 42. ');
    expect(r.text).toBe('答案是 42。');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 语言判定
// ═══════════════════════════════════════════════════════════

describe('⑤ 语言判定', () => {
  it('英文被识别', () => {
    expect(looksEnglish('Let me think about this problem.')).toBe(true);
  });

  it('中文不被识别为英文', () => {
    expect(looksEnglish('让我想想这个问题。')).toBe(false);
  });

  it('★ 中英混排里有较多中文时判为非英文', () => {
    expect(looksEnglish('这是一个 test 句子 with 一些 English')).toBe(false);
  });

  it('纯数字与符号不判为英文', () => {
    expect(looksEnglish('123 + 456 = 579')).toBe(false);
  });

  it('空串为 false', () => {
    expect(looksEnglish('')).toBe(false);
    expect(looksEnglish('   ')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ SSE 解析（适配器层）
// ═══════════════════════════════════════════════════════════

describe('⑥ SSE 解析', () => {
  it('★ 提取 data 行', () => {
    const parse = createSseParser();
    expect(parse('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('★★ 半行不解析（网络分片会切断行）', () => {
    const parse = createSseParser();
    expect(parse('data: {"a"')).toEqual([]);
    expect(parse(':1}\n')).toEqual(['{"a":1}']);
  });

  it('一次分片含多行时全部取出', () => {
    const parse = createSseParser();
    expect(parse('data: a\ndata: b\ndata: c\n')).toEqual(['a', 'b', 'c']);
  });

  it('跳过注释与空行', () => {
    const parse = createSseParser();
    expect(parse(': keep-alive\n\ndata: x\n')).toEqual(['x']);
  });

  it('[DONE] 被原样取出（由上层判断）', () => {
    const parse = createSseParser();
    expect(parse('data: [DONE]\n')).toEqual(['[DONE]']);
  });

  it('处理 CRLF', () => {
    const parse = createSseParser();
    expect(parse('data: x\r\n')).toEqual(['x']);
  });
});

describe('⑥ finish_reason 映射', () => {
  it('stop / length / tool_calls 正确映射', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('tool_calls')).toBe('toolCalls');
  });

  it('★★ 非正常结束都映射为 error（不能被当成完整结果）', () => {
    expect(mapFinishReason('content_filter')).toBe('error');
    expect(mapFinishReason('insufficient_system_resource')).toBe('error');
    expect(mapFinishReason('aborted')).toBe('error');
    expect(mapFinishReason(null)).toBe('error');
    expect(mapFinishReason(undefined)).toBe('error');
  });
});
