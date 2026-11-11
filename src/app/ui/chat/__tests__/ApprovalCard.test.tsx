/**
 * 运行中审批卡：内联渲染，不再包 Modal。
 *
 * 不需要 jsdom：react-dom/server 把卡片渲染成静态 HTML，
 * 直接断言“用户在输入框上方实际能看到什么、看不到什么”。
 */

import { readFileSync } from 'node:fs';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApprovalCard } from '../ApprovalCard.js';
import type { ApprovalItem } from '../approvalQueue.js';

const APPROVAL: ApprovalItem = {
  id: 'ap_1',
  toolName: 'write_file',
  tier: 'highRisk',
  summary: '写入 冰箱盘点.txt',
  preview: '--- a\n+++ b\n+ 鸡蛋',
};

function render(answering = false, pendingCount = 2): string {
  return renderToStaticMarkup(
    <ApprovalCard
      approval={APPROVAL}
      pendingCount={pendingCount}
      answering={answering}
      onAnswer={() => undefined}
    />,
  );
}

describe('ApprovalCard', () => {
  it('只保留操作名与两个决定', () => {
    const html = render();

    expect(html).toContain('需要确认的操作');
    expect(html).toContain('写入 冰箱盘点.txt');
    expect(html).toContain('拒绝');
    expect(html).toContain('允许一次');
    expect(html).toContain('还有 1 个');
  });

  it('不渲染 Modal / 遮罩 / 对话框角色', () => {
    const html = render();

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('modal-backdrop');
    expect(html).not.toContain('modal-panel');
  });

  it('不展示盾牌、原始工具名、风险徽章、一次性授权或预览代码', () => {
    const html = render();

    expect(html).not.toContain('write_file');
    expect(html).not.toContain('高风险');
    expect(html).not.toContain('一次性授权');
    expect(html).not.toContain('approval-preview');
    expect(html).not.toContain('+ 鸡蛋');
  });

  it('answering 时两个按钮都禁用', () => {
    const html = render(true, 1);
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('还有');
  });

  it('ChatView 已删除 Modal 包裹，改为渲染 ApprovalCard', () => {
    const source = readFileSync(new URL('../ChatView.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain("from '../components/Modal'");
    expect(source).not.toContain('<Modal');
    expect(source).toContain('<ApprovalCard');
  });
});
