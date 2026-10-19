/**
 * 询问通道（C6 · 方案 §11 第三层 / U-5）
 *
 * ★★ 这个模块补的是一个**红线上限**的缺口：
 *   在此之前，"需要确认"这一档**做不出来** ——
 *   `WebPermissionPolicy.ask()` 直接返回 `deny`，
 *   所以实际行为是「只读放行、其余一律拒绝」。
 *
 *   现在工具可以真的**停下来问**：推一条确认请求出去，等用户答复，超时即拒。
 *
 * ⚠️ 三条硬规则：
 *   ① **超时即拒绝**（fail-closed）—— 用户不响应不等于同意
 *   ② **流断即拒绝** —— 客户端关了、请求取消了，挂着的确认全部作废
 *   ③ **不记得"这个工具以后都允许"** —— C5 的"记住本次会话"是另一层，
 *      这层只回答"这一次允不允许"
 */

import type { ActionTier } from './types.js';

/** 一条等待用户确认的请求 */
export interface ApprovalRequest {
  readonly id: string;
  readonly toolName: string;
  readonly tier: ActionTier;
  /** 一句话说明这次要做什么（给用户看） */
  readonly summary: string;
  /** 只读预览（要动到什么），可能没有 */
  readonly preview?: string;
  /** 超时时间（毫秒），到点自动拒绝 */
  readonly timeoutMs: number;
}

/** 工具侧只依赖这个窄接口（便于测试注入假实现） */
export interface ApprovalAsker {
  /** 返回 true 表示允许执行 */
  request(req: Omit<ApprovalRequest, 'id' | 'timeoutMs'>): Promise<boolean>;
}

/**
 * 全局登记表：`id → 答复函数`。
 *
 * ★ 为什么需要全局表：确认请求由**某一轮对话**发起（SSE 流里），
 *   而答复来自**另一个 HTTP 请求**（`POST /api/approval`）。
 *   两者不在同一个闭包里，只能靠一张按 id 查找的表接上。
 *
 * ⚠️ 每个条目**必定**在 `settle` 里被删除（答复/超时/流断三条路都走它），
 *    否则会随会话数量增长而泄漏。
 */
const PENDING = new Map<string, (allow: boolean) => void>();

/** 供 `POST /api/approval` 调用：把用户答复送回等待中的那一轮 */
export function resolveApproval(id: string, allow: boolean): boolean {
  const settle = PENDING.get(id);
  if (settle === undefined) return false;
  settle(allow);
  return true;
}

/** 当前挂着多少个确认（诊断/测试用） */
export function pendingApprovalCount(): number {
  return PENDING.size;
}

export interface SseApprovalsOptions {
  /** 把确认请求推给调用方（通常是 SSE 的 `send`） */
  readonly emit: (req: ApprovalRequest) => void;
  /** 默认超时（毫秒）。默认 120 秒 —— 太短用户来不及看，太长会占着工具循环 */
  readonly timeoutMs?: number;
  /** id 生成器（测试可注入确定性实现） */
  readonly makeId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 基于 SSE 的询问实现：推请求 → 等答复 → 超时拒绝。
 */
export class SseApprovals implements ApprovalAsker {
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly makeId: () => string;

  constructor(private readonly opts: SseApprovalsOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.makeId = opts.makeId ?? (() => `ap_${Date.now().toString(36)}_${++this.seq}`);
  }

  request(req: Omit<ApprovalRequest, 'id' | 'timeoutMs'>): Promise<boolean> {
    const id = this.makeId();
    const full: ApprovalRequest = { ...req, id, timeoutMs: this.timeoutMs };

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (allow: boolean): void => {
        if (settled) return;
        settled = true;
        PENDING.delete(id);
        clearTimeout(timer);
        resolve(allow);
      };

      // ① 超时即拒绝（fail-closed）——用户不响应 ≠ 同意
      const timer = setTimeout(() => settle(false), this.timeoutMs);

      PENDING.set(id, settle);

      // ② 推给调用方。推送本身出错也必须收敛成"拒绝"，不能让 Promise 永远挂着。
      try {
        this.opts.emit(full);
      } catch {
        settle(false);
      }
    });
  }
}

/**
 * 把**所有**挂着的确认一次性拒绝。
 *
 * ★ 用在流结束/连接关闭时：客户端都关了，没人会来点"允许"。
 *   不这么做的话，工具循环会一直等到超时（最长 2 分钟）。
 */
export function denyAllPending(): number {
  const count = PENDING.size;
  for (const [, settle] of PENDING) settle(false);
  PENDING.clear();
  return count;
}
