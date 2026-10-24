/**
 * 手动复核（v10 后端）
 *
 * POST /api/reviews   { sessionId, messageId | messageIds: string[] }
 *   → 重新调用监督员；多轮范围只生成一个 ReviewRun
 * GET  /api/reviews?sessionId=... → 该会话的 ReviewRun 历史
 */

import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { supervise } from '@/core/butler/supervisor.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = (req.nextUrl.searchParams.get('sessionId') ?? '').trim();
  if (sessionId.length === 0) {
    return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
  }
  const rt = await getRuntime();
  if (rt.bootstrapped.chat.getSession(sessionId) === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    reviews: rt.bootstrapped.chat.reviewRunsOf(sessionId),
  });
}

interface Body {
  readonly sessionId?: unknown;
  readonly messageId?: unknown;
  readonly messageIds?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const singleId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
  const requested = Array.isArray(body.messageIds)
    ? body.messageIds.filter((x): x is string => typeof x === 'string').map((x) => x.trim())
    : singleId.length > 0
      ? [singleId]
      : [];
  const messageIds = [...new Set(requested.filter((x) => x.length > 0))];
  if (sessionId.length === 0 || messageIds.length === 0) {
    return NextResponse.json({ error: '缺少 sessionId / messageId(s)' }, { status: 400 });
  }

  const rt = await getRuntime();
  if (rt.model === null) {
    return NextResponse.json({ error: '还没有配置模型，无法重新复核' }, { status: 503 });
  }

  const messages = messageIds.map((id) =>
    rt.bootstrapped.chat.messagesOf(sessionId).find((m) => m.id === id),
  );
  if (messages.some((m) => m === undefined || m.reviewSnapshot === undefined)) {
    return NextResponse.json(
      { error: '复核范围内有 turn 缺少 reviewSnapshot（可能是旧消息或未完成）' },
      { status: 404 },
    );
  }
  const snapshots = messages.map((m) => m!.reviewSnapshot!);

  const snapshotHash = createHash('sha256')
    .update(JSON.stringify(snapshots))
    .digest('hex')
    .slice(0, 16);
  const modelName = rt.model.describe().model;
  const turnIds = messages.map((m) => m!.id);

  const turns: { readonly messageId: string; readonly summary: string; readonly criteria: number }[] = [];
  const allCriteria: { criterion: string; met: boolean; note?: string | undefined }[] = [];
  const allFindings: {
    viewpoint: 'contract' | 'domain' | 'global';
    severity: 'info' | 'warn' | 'block';
    message: string;
    evidence: readonly string[];
  }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let promptVersion = '';

  try {
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i]!;
      const result = await supervise({
        model: rt.model,
        log: rt.bootstrapped.log,
        userGoal: snapshot.userGoal,
        contract: snapshot.contract,
        reports: [],
        hardConstraints: snapshot.hardConstraints,
        outputSummary: snapshot.outputSummary,
        now: Date.now(),
        signal: req.signal,
      });
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      if (promptVersion.length === 0) promptVersion = result.promptVersion;
      allCriteria.push(...result.output.criteriaChecks);
      allFindings.push(...result.output.findings);
      turns.push({
        messageId: turnIds[i]!,
        summary: result.output.summary,
        criteria: result.output.criteriaChecks.length,
      });
    }

    const aggregate = {
      criteriaChecks: allCriteria,
      findings: allFindings,
      summary: turns.map((t, i) => `第 ${i + 1} 轮\n${t.summary}`).join('\n\n'),
    };
    const run = rt.bootstrapped.chat.appendReviewRun({
      sessionId,
      turnIds,
      status: 'completed',
      model: modelName,
      promptVersion,
      snapshotHash,
      stages: [
        { name: 'snapshot', status: 'done' },
        { name: 'supervision', status: 'done' },
      ],
      report: aggregate,
      usage: { inputTokens, outputTokens },
    });
    return NextResponse.json({
      ok: true,
      run,
      output: aggregate,
      turns,
      usage: run.usage,
      promptVersion,
    });
  } catch (err) {
    const aborted = req.signal.aborted === true;
    const messageText = aborted ? '审查已取消' : err instanceof Error ? err.message : String(err);
    const run = rt.bootstrapped.chat.appendReviewRun({
      sessionId,
      turnIds,
      status: aborted ? 'aborted' : 'failed',
      model: modelName,
      promptVersion: 'unknown',
      snapshotHash,
      stages: [
        { name: 'snapshot', status: 'done' },
        { name: 'supervision', status: 'failed' },
      ],
      report: null,
      usage: { inputTokens, outputTokens },
      error: messageText,
    });
    return NextResponse.json(
      { error: messageText, runId: run.id },
      { status: aborted ? 499 : 502 },
    );
  }
}
