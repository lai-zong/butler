/**
 * 本轮取消 —— 用户点“停止”时必须真的停住后台，而不是只断开浏览器。
 *
 * ★ 为什么单独定义错误类型：
 *   编排层对普通异常的处理是“产出一份失败汇报”，让界面看得见原因；
 *   但取消不是失败，不能继续跑校验/监督/反思，也不能把“用户主动停止”
 *   伪装成“任务失败”。所以取消必须能被识别并原样向上抛。
 */

export class TurnAbortedError extends Error {
  constructor() {
    super('用户已停止本轮任务');
    this.name = 'TurnAbortedError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new TurnAbortedError();
}

/** 兼容适配器抛出的原生 AbortError / DOMException。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof TurnAbortedError) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TurnAbortedError';
  }
  return false;
}
