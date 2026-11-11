'use client';

/**
 * 运行中审批 —— 贴在输入框正上方的内联卡。
 *
 * ★ 刻意不是 Modal：
 *   · 不遮罩、不锁滚动、不做焦点陷阱；
 *   · 输入框始终可用，用户可以先写一段话再点“允许/拒绝”；
 *   · 卡片只保留操作名与两个决定，不放工具名、风险徽章或预览代码。
 *
 * 数据仍来自 approvalQueue：一次只显示队首，处理完自动露出下一张。
 */

import React from 'react';

import type { ApprovalItem } from './approvalQueue.js';

interface ApprovalCardProps {
  readonly approval: ApprovalItem;
  /** 队列总长度；只用来在右上角提示“还有 N 个”。 */
  readonly pendingCount: number;
  readonly answering: boolean;
  readonly onAnswer: (allow: boolean) => void;
}

export function ApprovalCard({
  approval,
  pendingCount,
  answering,
  onAnswer,
}: ApprovalCardProps): JSX.Element {
  return (
    <section className="approval-card" role="group" aria-label="需要确认的操作">
      <div className="approval-card-head">
        <span className="approval-card-title">需要确认的操作</span>
        {pendingCount > 1 && (
          <span className="approval-card-more">还有 {pendingCount - 1} 个</span>
        )}
      </div>
      <div className="approval-card-row">
        <p className="approval-card-summary">{approval.summary}</p>
        <div className="approval-card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={answering}
            onClick={() => onAnswer(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={answering}
            onClick={() => onAnswer(true)}
          >
            允许一次
          </button>
        </div>
      </div>
    </section>
  );
}
