/**
 * 中途停止的归类与话术
 *
 * ★ 为什么单独成模块：这四类的**处置方式完全不同** ——
 *   自己点的停止要能重试、余额不足要去充值、网络断开要等一会儿、
 *   其它错误要看原文。把它们混成一句"出错了"，用户没法判断下一步。
 */

export type InterruptReason = 'user_stopped' | 'insufficient_balance' | 'network' | 'error';

/**
 * 把异常归成四类。
 *
 * ⚠️ 只做关键词匹配：各模型的错误文案差别很大，但"余额不足/额度"和
 *    "网络断"一定会带上可识别的词；剩下的归为 error，原文仍会显示给用户。
 */
export function classifyTurnFailure(err: unknown): InterruptReason {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    message.includes('insufficient') ||
    message.includes('balance') ||
    message.includes('余额') ||
    message.includes('quota') ||
    message.includes('402')
  ) {
    return 'insufficient_balance';
  }
  if (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('network')
  ) {
    return 'network';
  }
  return 'error';
}

/**
 * 生成落盘的中断消息正文。
 *
 * ★ 不伪造模型没说过的内容：这里只写"发生了什么 + 完成了多少"，
 *   真正的过程留在 auditRange 指向的事件区间里，审查面板照样展开。
 */
export function interruptedNote(args: {
  readonly reason: InterruptReason;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly error?: unknown;
}): string {
  const pending = args.toolCalls > args.toolResults ? '，其中一次尚未返回' : '';
  switch (args.reason) {
    case 'user_stopped':
      return `> 本轮已终止：你点了停止。已保留已生成的内容；已完成 ${args.toolResults} 次工具调用${pending}。过程与本轮依据可展开查看。`;
    case 'insufficient_balance':
      return '> 本轮中断：模型余额不足。已经完成的部分保留在这里，可以审查。';
    case 'network':
      return '> 本轮中断：网络异常，连接没有撑到结束。已保留已完成的部分，可以审查。';
    default:
      return `> 本轮中断：${args.error instanceof Error ? args.error.message : String(args.error)}。已保留已完成的部分，可以审查。`;
  }
}
