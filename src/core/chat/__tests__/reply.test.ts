import { describe, expect, it } from 'vitest';

import { buildAcceptedReply } from '../service.js';
import type { Verdict } from '../types.js';
import type { ExecutionReport } from '../../execution/types.js';

function report(reply: string, artifactText: string): ExecutionReport {
  return {
    servant: 'life',
    taskId: 't1',
    status: 'done',
    reply,
    instruction: 'internal instruction',
    artifacts: [{ kind: 'text', content: artifactText, itemCount: 1 }],
    findings: [],
    uncertainties: [],
    injectedConstraints: [],
  } as unknown as ExecutionReport;
}

const accepted = {
  id: 'v1',
  sessionId: 's1',
  forMessageId: 'm1',
  outcome: 'accepted',
  summary: '四条判据全部满足；未发现问题。',
  issues: [],
  criteriaChecks: [],
  steps: [],
  durationMs: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  artifactIds: [],
  createdAt: 1,
} as Verdict;

describe('用户正文不能混入监督员内部结论', () => {
  it('优先使用 report.reply，不输出 supervision summary / artifacts 指令', () => {
    const text = buildAcceptedReply(
      {
        reports: [report('你好！我在。\n\n上次的食材与过敏事项还可以继续。', '简短问候回应并列出待办')],
      },
      accepted,
    );

    expect(text).toContain('你好！我在。');
    expect(text).not.toContain('四条判据');
    expect(text).not.toContain('简短问候回应并列出待办');
  });

  it('没有 reply 时才回退到 artifacts', () => {
    const text = buildAcceptedReply(
      { reports: [report('', '结构化产出正文')] },
      accepted,
    );
    expect(text).toBe('结构化产出正文');
  });
});
