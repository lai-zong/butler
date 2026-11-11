/**
 * 运行中发送消息（steering）的纯逻辑测试。
 *
 * 覆盖后端契约里最容易写错的四件事：
 *   · 有/没有 pending 审批时，请求体是否带 cancelApprovals；
 *   · 审批按钮带/不带文字时，text 是否出现；
 *   · 409 no_active_turn 必须把文字还给输入框；
 *   · steering SSE 事件只确认一次，重复事件不产生第二条消息。
 *
 * 不需要 jsdom：这里只测纯函数，组件行为由 ApprovalCard.test.tsx 覆盖。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { ApiError } from '../../lib/api.js';
import type { SseEvent } from '../../lib/types.js';
import {
  addPendingSteering,
  approvalSteerBody,
  confirmSteering,
  isNoActiveTurnError,
  recoverFromSteerFailure,
  removePendingSteering,
  runningSteerBody,
  steeringStatusLabel,
} from '../steer.js';

function noActiveTurn(): ApiError {
  return new ApiError('当前没有正在执行的轮次', 409, {
    error: '当前没有正在执行的轮次',
    code: 'no_active_turn',
  });
}

describe('runningSteerBody', () => {
  it('普通运行中只带 sessionId/text（并去掉首尾空白）', () => {
    const body = runningSteerBody('s1', '  再看看冰箱  ', false);

    expect(body).toEqual({ sessionId: 's1', text: '再看看冰箱' });
    expect(body).not.toHaveProperty('cancelApprovals');
  });

  it('有 pending 审批时带 cancelApprovals: true', () => {
    const body = runningSteerBody('s1', '别写文件了', true);

    expect(body).toEqual({
      sessionId: 's1',
      text: '别写文件了',
      cancelApprovals: true,
    });
  });
});

describe('approvalSteerBody', () => {
  it('没有文字时只带 approvalId/allow（以及 sessionId）', () => {
    const body = approvalSteerBody('s1', 'ap_1', true, '   ');

    expect(body).toEqual({
      sessionId: 's1',
      approvalId: 'ap_1',
      allow: true,
    });
    expect(body).not.toHaveProperty('text');
  });

  it('有文字时审批决定和文字一起提交', () => {
    const body = approvalSteerBody('s1', 'ap_1', false, '  换成只读  ');

    expect(body).toEqual({
      sessionId: 's1',
      approvalId: 'ap_1',
      allow: false,
      text: '换成只读',
    });
  });
});

describe('409 no_active_turn 恢复', () => {
  it('识别 409 + code=no_active_turn', () => {
    expect(isNoActiveTurnError(noActiveTurn())).toBe(true);
    expect(isNoActiveTurnError(new ApiError('审批失效', 409, { code: 'invalid_approval' }))).toBe(
      false,
    );
    expect(isNoActiveTurnError(new ApiError('服务端错误', 500, null))).toBe(false);
    expect(isNoActiveTurnError(new Error('no_active_turn'))).toBe(false);
  });

  it('恢复输入，并标记收尾后用普通发送补上', () => {
    expect(recoverFromSteerFailure(noActiveTurn(), '  补一句  ')).toEqual({
      input: '补一句',
      resumeAfterTurn: '补一句',
      clearApprovals: true,
    });
  });

  it('普通网络错误也恢复输入，但不自动重发', () => {
    expect(recoverFromSteerFailure(new ApiError('断网了', 0, null), '补一句')).toEqual({
      input: '补一句',
      resumeAfterTurn: null,
      clearApprovals: false,
    });
  });
});

describe('steering 事件去重', () => {
  it('乐观消息被同文本事件确认：只标记，不新增', () => {
    const pending = addPendingSteering([], '先别删除文件');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ text: '先别删除文件', delivered: false });

    const confirmed = confirmSteering(pending, '先别删除文件');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ text: '先别删除文件', delivered: true });
  });

  it('重复的 steering 事件不会显示第二条', () => {
    const first = confirmSteering(addPendingSteering([], '等一下'), '等一下');
    const second = confirmSteering(first, '等一下');

    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it('没有乐观消息（例如另一个页面发出）时补一条已确认消息', () => {
    const messages = confirmSteering([], '来自另一页面的补充');
    expect(messages).toEqual([
      { seq: 1, text: '来自另一页面的补充', delivered: true },
    ]);
  });

  it('两条同文本乐观消息可以被两个事件分别确认', () => {
    const pending = addPendingSteering(addPendingSteering([], '再查一下'), '再查一下');
    const once = confirmSteering(pending, '再查一下');
    const twice = confirmSteering(once, '再查一下');

    expect(twice).toHaveLength(2);
    expect(twice.every((m) => m.delivered)).toBe(true);
  });

  it('失败时只撤掉未确认的那条，已确认的保留', () => {
    const pending = addPendingSteering([], '别动');
    expect(removePendingSteering(pending, '别动')).toEqual([]);

    const confirmed = confirmSteering(pending, '别动');
    expect(removePendingSteering(confirmed, '别动')).toBe(confirmed);
  });

  it('状态文案：未确认且本轮运行中 = 等待；确认或本轮已结束 = 已发送', () => {
    expect(steeringStatusLabel(false, false)).toBe('等待当前步骤结束');
    expect(steeringStatusLabel(true, false)).toBe('已发送');
    // SSE 收尾时如果 POST 还没返回，先按“本轮已结束”显示；失败会整条撤掉。
    expect(steeringStatusLabel(false, true)).toBe('已发送');
  });
});

describe('SSE 类型契约', () => {
  it('SseEvent 包含 steering 文本事件', () => {
    expectTypeOf<Extract<SseEvent, { type: 'steering' }>>().toEqualTypeOf<{
      readonly type: 'steering';
      readonly text: string;
    }>();
  });
});

describe('ChatView 接线', () => {
  it('streaming 分支调用 steerRunning；请求体由 runningSteerBody 生成', () => {
    const source = readFileSync(new URL('../ChatView.tsx', import.meta.url), 'utf8');
    const sendStart = source.indexOf('async function send(');
    const steerStart = source.indexOf('async function steerRunning(');
    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(steerStart).toBeGreaterThan(sendStart);

    const sendBody = source.slice(sendStart, steerStart);
    expect(sendBody).toContain('if (streaming)');
    expect(sendBody).toContain('steerRunning(text)');

    const steerBody = source.slice(steerStart);
    expect(steerBody).toContain('runningSteerBody(id, text, cancelApprovals)');
    expect(steerBody).toContain("postJson<SteerResponse>('/api/chat/steer', body)");
  });
});
