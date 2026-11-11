/**
 * 询问通道（C6 · 方案 §11 第三层 / U-5）
 *
 * ★★ 这个模块补的是一个**红线上限**的缺口：
 *   在此之前，"需要确认"这一档**做不出来** ——
 *   `WebPermissionPolicy.ask()` 直接返回 `deny`，
 *   所以实际行为是「只读放行、其余一律拒绝」。
 *
 *   现在工具可以真的**停下来问**：推一条确认请求出去，等用户答复。
 *
 * ⚠️ 三条硬规则：
 *   ① **不设超时** —— 用户不回答，就一直等；不会替他做决定
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
}

/** 工具侧只依赖这个窄接口（便于测试注入假实现） */
export interface ApprovalAsker {
  /** 返回 true 表示允许执行 */
  request(req: Omit<ApprovalRequest, 'id'>): Promise<boolean>;
}

/**
 * 全局登记表：`id → 答复函数`。
 *
 * ★ 为什么需要全局表：确认请求由**某一轮对话**发起（SSE 流里），
 *   而答复来自**另一个 HTTP 请求**（`POST /api/approval`）。
 *   两者不在同一个闭包里，只能靠一张按 id 查找的表接上。
 *
 * ⚠️ 不能只写成模块级 `const PENDING`：
 *    Next.js 会把 `/api/chat` 和 `/api/approval` 编成不同的路由 chunk，
 *    同一个模块可能在两个 chunk 里各有一份模块状态。
 *    实测结果是：chat 路由挂起的 id 在 approval 路由里查不到，
 *    页面点“拒绝”收到 409，而工具侧一直等不到答复。
 *
 *    所以登记表必须落在**进程级 globalThis** 上，而不是模块闭包里。
 *
 * ⚠️ 每个条目**必定**在 `settle` 里被删除（答复/流断两条路都走它），
 *    否则会随会话数量增长而泄漏。
 */
interface ApprovalGlobal {
  __butlerPendingApprovals?: Map<string, (allow: boolean) => void>;
}

function pendingMap(): Map<string, (allow: boolean) => void> {
  const scope = globalThis as typeof globalThis & ApprovalGlobal;
  const existing = scope.__butlerPendingApprovals;
  if (existing !== undefined) return existing;
  const created = new Map<string, (allow: boolean) => void>();
  scope.__butlerPendingApprovals = created;
  return created;
}

/** 供 `POST /api/approval` 调用：把用户答复送回等待中的那一轮 */
export function resolveApproval(id: string, allow: boolean): boolean {
  const settle = pendingMap().get(id);
  if (settle === undefined) return false;
  settle(allow);
  return true;
}

/** 当前挂着多少个确认（诊断/测试用） */
export function pendingApprovalCount(): number {
  return pendingMap().size;
}

export interface SseApprovalsOptions {
  /** 把确认请求推给调用方（通常是 SSE 的 `send`） */
  readonly emit: (req: ApprovalRequest) => void;
  /** id 生成器（测试可注入确定性实现） */
  readonly makeId?: () => string;
}

/**
 * 基于 SSE 的询问实现：推请求 → 一直等答复。
 * 不设超时；只有用户答复、推送失败或本轮流关闭（asker.denyAll）才收敛。
 */
export class SseApprovals implements ApprovalAsker {
  private seq = 0;
  private readonly ids = new Set<string>();
  private readonly makeId: () => string;

  constructor(private readonly opts: SseApprovalsOptions) {
    // 每个 asker 有独立前缀：两个会话在同一毫秒发起确认时，局部 seq 不能撞 id。
    const prefix = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.makeId = opts.makeId ?? (() => `${prefix}_${++this.seq}`);
  }

  request(req: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
    const id = this.makeId();
    const full: ApprovalRequest = { ...req, id };

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (allow: boolean): void => {
        if (settled) return;
        settled = true;
        this.ids.delete(id);
        pendingMap().delete(id);
        resolve(allow);
      };

      this.ids.add(id);
      pendingMap().set(id, settle);

      // 推给调用方。推送本身出错也必须收敛成"拒绝"，不能让 Promise 永远挂着。
      try {
        this.opts.emit(full);
      } catch {
        settle(false);
      }
    });
  }

  /**
   * 只取消本 asker 发起的确认。
   *
   * ★ 不能用全局 `denyAllPending()` 收尾：两个会话同时挂起时，
   *   一个会话结束会把另一个会话的待确认也打掉。没有超时后这个问题更明显。
   */
  denyAll(): number {
    let count = 0;
    for (const id of [...this.ids]) {
      const settle = pendingMap().get(id);
      if (settle !== undefined) {
        settle(false);
        count += 1;
      } else {
        this.ids.delete(id);
      }
    }
    return count;
  }
}

/**
 * 把**所有**挂着的确认一次性拒绝。
 *
 * ★ 用在流结束/连接关闭时：客户端都关了，没人会来点"允许"。
 *   不这么做的话，工具循环会一直挂着。
 */
export function denyAllPending(): number {
  const pending = pendingMap();
  const count = pending.size;
  for (const [, settle] of pending) settle(false);
  pending.clear();
  return count;
}
