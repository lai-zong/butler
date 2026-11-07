/**
 * 询问通道测试（C6）
 *
 * ★ 这一层的核心不是"能问"，而是**问不到时怎么走**：
 *   用户不响应、客户端关了、id 已作废 —— 三种情况都必须**拒绝**。
 *   任何一条走了"放行"，就是安全漏洞。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  denyAllPending,
  pendingApprovalCount,
  resolveApproval,
  SseApprovals,
  type ApprovalRequest,
} from '../approval.js';

const REQ = { toolName: 'write_file', tier: 'normal' as const, summary: '写文件 a.txt' };

afterEach(() => {
  // 全局登记表是模块级的，测试之间必须清干净，否则会互相干扰
  denyAllPending();
});

describe('SseApprovals —— 正常答复', () => {
  it('★ 用户允许 → request 返回 true', async () => {
    const sent: ApprovalRequest[] = [];
    const asker = new SseApprovals({ emit: (r) => sent.push(r) });

    const pending = asker.request(REQ);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.toolName).toBe('write_file');
    expect(pendingApprovalCount()).toBe(1);

    // 模拟调用方 POST /api/approval
    expect(resolveApproval(sent[0]!.id, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(pendingApprovalCount()).toBe(0);
  });

  it('★ 用户拒绝 → request 返回 false', async () => {
    const sent: ApprovalRequest[] = [];
    const asker = new SseApprovals({ emit: (r) => sent.push(r) });
    const pending = asker.request(REQ);
    resolveApproval(sent[0]!.id, false);
    await expect(pending).resolves.toBe(false);
  });

  it('preview 会原样推给调用方（用户得看到"要动到什么"）', async () => {
    const sent: ApprovalRequest[] = [];
    const asker = new SseApprovals({ emit: (r) => sent.push(r) });
    void asker.request({ ...REQ, preview: '将覆盖 a.txt（原 12 字节）' });
    expect(sent[0]?.preview).toContain('覆盖');
  });
});

describe('★★★ 问不到的时候必须拒绝（fail-closed）', () => {
  it('★★ 超时未答复 → 拒绝', async () => {
    vi.useFakeTimers();
    try {
      const asker = new SseApprovals({ emit: () => undefined, timeoutMs: 1000 });
      const pending = asker.request(REQ);
      expect(pendingApprovalCount()).toBe(1);

      vi.advanceTimersByTime(1001);
      await expect(pending).resolves.toBe(false);
      expect(pendingApprovalCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('★★ 流结束（denyAllPending）→ 全部拒绝', async () => {
    const asker = new SseApprovals({ emit: () => undefined });
    const a = asker.request(REQ);
    const b = asker.request({ ...REQ, summary: '第二个操作' });
    expect(pendingApprovalCount()).toBe(2);

    expect(denyAllPending()).toBe(2);
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(pendingApprovalCount()).toBe(0);
  });

  it('★★ 推送本身抛错 → 拒绝（不能永远挂着）', async () => {
    const asker = new SseApprovals({
      emit: () => {
        throw new Error('SSE 已断开');
      },
    });
    await expect(asker.request(REQ)).resolves.toBe(false);
    expect(pendingApprovalCount()).toBe(0);
  });

  it('★ 已答复的 id 再答复 → 返回 false（不能补答作废请求）', async () => {
    const sent: ApprovalRequest[] = [];
    const asker = new SseApprovals({ emit: (r) => sent.push(r) });
    const pending = asker.request(REQ);
    expect(resolveApproval(sent[0]!.id, true)).toBe(true);
    await pending;

    expect(resolveApproval(sent[0]!.id, false)).toBe(false);
  });

  it('★ 不存在的 id → 返回 false', () => {
    expect(resolveApproval('ap_nope', true)).toBe(false);
  });

  it('★★ 不同路由 chunk 的两份模块必须共享同一张登记表', async () => {
    // 模拟 Next.js 将 /api/chat 与 /api/approval 分别打包：
    // 模块闭包重建，但 globalThis 仍是同一个进程。
    vi.resetModules();
    const chatSide = await import('../approval.js');
    const sent: ApprovalRequest[] = [];
    const asker = new chatSide.SseApprovals({ emit: (r) => sent.push(r) });
    const pending = asker.request(REQ);
    expect(chatSide.pendingApprovalCount()).toBe(1);

    vi.resetModules();
    const approvalSide = await import('../approval.js');
    expect(approvalSide.pendingApprovalCount()).toBe(1);
    expect(approvalSide.resolveApproval(sent[0]!.id, false)).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(approvalSide.pendingApprovalCount()).toBe(0);
  });
});

describe('并发与隔离', () => {
  it('★ 多条并发确认互不干扰（各自的答复只影响自己）', async () => {
    const sent: ApprovalRequest[] = [];
    const asker = new SseApprovals({ emit: (r) => sent.push(r) });

    const a = asker.request({ ...REQ, summary: 'A' });
    const b = asker.request({ ...REQ, summary: 'B' });
    expect(sent).toHaveLength(2);

    resolveApproval(sent[1]!.id, true); // 只答复第二条
    await expect(b).resolves.toBe(true);

    resolveApproval(sent[0]!.id, false);
    await expect(a).resolves.toBe(false);
  });

  it('id 不重复（同一毫秒内多次请求也不撞）', async () => {
    const ids: string[] = [];
    const asker = new SseApprovals({ emit: (r) => ids.push(r.id) });
    void asker.request(REQ);
    void asker.request(REQ);
    void asker.request(REQ);
    expect(new Set(ids).size).toBe(3);
  });
});
