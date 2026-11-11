import { describe, expect, it } from 'vitest';

import { milestoneForTool } from '../petMilestones.js';

describe('pet milestones', () => {
  it('成功与失败给不同的人话摘要', () => {
    expect(milestoneForTool({ name: 'read_file', ok: true, denied: false })).toContain('文件读到了');
    expect(milestoneForTool({ name: 'read_file', ok: false, denied: false })).toContain('没读出来');
    expect(milestoneForTool({ name: 'write_file', ok: true, denied: false })).toContain('改好了');
    expect(milestoneForTool({ name: 'plan_task', ok: true, denied: false })).toContain('理一下');
  });

  it('拒绝与未知工具不编造进度', () => {
    expect(milestoneForTool({ name: 'write_file', ok: false, denied: true })).toContain('需要你确认');
    expect(milestoneForTool({ name: 'some_mcp_tool', ok: true, denied: false })).toBeNull();
  });
});
