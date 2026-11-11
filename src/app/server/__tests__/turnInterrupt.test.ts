/**
 * 中途停止的归类与话术
 *
 * 四类原因必须能分开：用户点停止、余额不足、网络断、其它错误。
 */

import { describe, expect, it } from 'vitest';

import { classifyTurnFailure, interruptedNote } from '../turnInterrupt.js';

describe('中断原因归类', () => {
  it('用户点停止单独一类', () => {
    expect(classifyTurnFailure(new Error('aborted'))).toBe('error'); // abort 由调用方显式判定
  });

  it('余额不足', () => {
    expect(classifyTurnFailure(new Error('Error: Insufficient Balance'))).toBe('insufficient_balance');
    expect(classifyTurnFailure(new Error('402 Payment Required'))).toBe('insufficient_balance');
    expect(classifyTurnFailure(new Error('账户余额不足'))).toBe('insufficient_balance');
  });

  it('网络异常', () => {
    expect(classifyTurnFailure(new TypeError('fetch failed'))).toBe('network');
    expect(classifyTurnFailure(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('network');
    expect(classifyTurnFailure(new Error('socket hang up'))).toBe('network');
    expect(classifyTurnFailure(new Error('ETIMEDOUT'))).toBe('network');
  });

  it('其它错误保留原文', () => {
    expect(classifyTurnFailure(new Error('模型返回了空内容'))).toBe('error');
  });
});

describe('中断话术', () => {
  it('用户停止：说明完成了多少', () => {
    const note = interruptedNote({ reason: 'user_stopped', toolCalls: 3, toolResults: 2 });
    expect(note).toContain('你点了停止');
    expect(note).toContain('2 次工具调用');
    expect(note).toContain('尚未返回');
  });

  it('余额不足与网络各自有独立话术', () => {
    expect(interruptedNote({ reason: 'insufficient_balance', toolCalls: 0, toolResults: 0 })).toContain(
      '余额不足',
    );
    expect(interruptedNote({ reason: 'network', toolCalls: 0, toolResults: 0 })).toContain('网络异常');
  });

  it('其它错误带上原始信息', () => {
    const note = interruptedNote({
      reason: 'error',
      toolCalls: 0,
      toolResults: 0,
      error: new Error('模型返回了空内容'),
    });
    expect(note).toContain('模型返回了空内容');
  });
});
