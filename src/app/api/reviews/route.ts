/**
 * 手动审查（新架构）
 *
 * 单模型、完整上下文、同一套工具、只读作用域。
 * 不再使用 reviewSnapshot / supervise() / 多视角模板。
 *
 * POST /api/reviews  → SSE：
 *   started / round / reasoning / text / tool_call / tool_started /
 *   tool_result / usage / completed / error
 * GET  /api/reviews?sessionId=... → 历史 ReviewRun（含 traces）
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { createChatToolScope } from '@/app/server/chatToolScope.js';
import { getKnowledgeService } from '@/app/server/knowledge.js';
import { createReviewSandbox, type ReviewSandbox } from '@/app/server/reviewSandbox.js';
import { dataDirOf, scopeDefaultsOf } from '@/app/server/sessionScope.js';
import { sessionSettingsOf } from '@/core/chat/settings.js';
import type {
  ReviewFinding,
  ReviewRun,
  ReviewTrace,
} from '@/core/chat/types.js';
import { msg } from '@/core/ports/model.js';
import type { ModelStreamPort } from '@/core/ports/stream.js';
import { runAgentLoop, type AgentProgressEvent } from '@/core/tools/agentLoop.js';
import type { ToolFramework } from '@/core/tools/framework.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

interface Body {
  readonly sessionId?: unknown;
  readonly messageIds?: unknown;
  readonly messageId?: unknown;
}

interface SelectedTurn {
  readonly userId: string;
  readonly assistantId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly trace: string;
  readonly state: 'done' | 'interrupted';
  /** 早期会话的 servant 回复：只作历史审查输入，不恢复成当前角色。 */
  readonly legacy: boolean;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0)
    : [];
}

function legacySummary(markdown: string): string {
  const lines = markdown
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s*/, '')
        .replace(/^\s*[-*>]\s*/, '')
        .replace(/^\*+\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !/^[-=]{3,}$/.test(line));
  const skip = new Set([
    '审查结论',
    '结论',
    '审查结果',
    '主要问题',
    '证据',
    '影响',
    '修改建议',
    '无法验证的部分',
    '无法验证',
    '备注',
    '附',
  ]);
  const first = lines.find((line) => !skip.has(line)) ?? lines[0] ?? '';
  return first.length > 180 ? `${first.slice(0, 180)}…` : first;
}

/**
 * 旧 ReviewRun 读取时归一化。只改返回值，不篡改历史事件。
 * 旧记录没有结构化 findings/unverified，就如实留空，不伪造。
 */
function normalizeLegacyRun(run: ReviewRun): ReviewRun {
  const report = run.report;
  if (report === null || report.verdict !== undefined || report.markdown !== undefined) {
    return run;
  }
  const markdown = report.summary.trim();
  const verdict: 'pass' | 'fail' | 'unknown' =
    /不通过|未通过|无法通过|不能原样交付/.test(markdown)
      ? 'fail'
      : /(^|[^不])通过|通过（|pass\b/i.test(markdown)
        ? 'pass'
        : 'unknown';

  const rawFindings = (report as unknown as { readonly findings?: unknown }).findings;
  const findings: ReviewFinding[] = Array.isArray(rawFindings)
    ? rawFindings.flatMap((raw): ReviewFinding[] => {
        const item = record(raw);
        if (item === null) return [];
        const severity =
          item['severity'] === 'block' || item['severity'] === 'warn' || item['severity'] === 'info'
            ? item['severity']
            : 'warn';
        const problem = str(item['problem']) || str(item['message']) || str(item['statement']);
        const evidence = stringList(item['evidence']);
        if (problem.length === 0 || evidence.length === 0) return [];
        const suggestion = str(item['suggestion']);
        return [{
          severity,
          problem,
          evidence,
          ...(suggestion.length > 0 ? { suggestion } : {}),
        }];
      })
    : [];
  const rawUnverified = (report as unknown as { readonly unverified?: unknown }).unverified;

  return {
    ...run,
    report: {
      summary: legacySummary(markdown) || markdown.slice(0, 180),
      verdict,
      findings,
      unverified: stringList(rawUnverified),
      markdown,
      legacy: true,
    },
  };
}

/**
 * 当前回复是 butler；servant 只作为早期历史格式兼容。
 * 这里不是把 servant 重新定义成当前角色，而是允许审查旧会话。
 */
function isReviewAssistant(message: { readonly role: string }): boolean {
  return message.role === 'butler' || message.role === 'servant';
}

function reviewState(status: string): 'done' | 'interrupted' | null {
  if (status === 'done') return 'done';
  if (status === 'interrupted') return 'interrupted';
  return null;
}

function toReviewTrace(t: {
  readonly round: number;
  readonly toolName: string;
  readonly args: unknown;
  readonly validated: boolean;
  readonly validationMessage?: string | undefined;
  readonly output?: string | undefined;
  readonly ok: boolean;
  readonly denied?: boolean | undefined;
  readonly durationMs: number;
}): ReviewTrace {
  return {
    round: t.round,
    toolName: t.toolName,
    args: t.args,
    validated: t.validated,
    ...(t.validationMessage !== undefined ? { validationMessage: t.validationMessage } : {}),
    ...(t.output !== undefined ? { output: t.output } : {}),
    ok: t.ok,
    ...(t.denied !== undefined ? { denied: t.denied } : {}),
    durationMs: t.durationMs,
  };
}

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
    reviews: rt.bootstrapped.chat.reviewRunsOf(sessionId).map(normalizeLegacyRun),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const requested = Array.isArray(body.messageIds)
    ? body.messageIds.filter((x): x is string => typeof x === 'string').map((x) => x.trim())
    : str(body.messageId).length > 0
      ? [str(body.messageId)]
      : [];
  const messageIds = [...new Set(requested.filter((x) => x.length > 0))];
  if (sessionId.length === 0 || messageIds.length === 0) {
    return NextResponse.json(
      { error: '缺少 sessionId / messageId(s)' },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(sessionId);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }
  const reviewModel = rt.model;
  if (reviewModel === null) {
    return NextResponse.json({ error: '还没有配置模型，无法审查' }, { status: 503 });
  }

  const messages = chat.messagesOf(sessionId);
  const selected: SelectedTurn[] = [];
  for (const id of messageIds) {
    const assistantIndex = messages.findIndex(
      (m) => m.id === id && isReviewAssistant(m),
    );
    if (assistantIndex < 0) continue;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex]!.role !== 'user') userIndex -= 1;
    if (userIndex < 0) continue;
    const assistant = messages[assistantIndex]!;
    const state = reviewState(assistant.status);
    if (state === null) continue;
    const user = messages[userIndex]!;
    const trace =
      assistant.agentTrace !== undefined
        ? JSON.stringify(assistant.agentTrace).slice(0, 5000)
        : '';
    selected.push({
      userId: user.id,
      assistantId: assistant.id,
      userText: user.text,
      assistantText: assistant.text,
      trace,
      state,
      legacy: assistant.role === 'servant',
    });
  }
  if (selected.length === 0) {
    return NextResponse.json(
      { error: '选中的轮次没有可审查的完成或中断回复' },
      { status: 400 },
    );
  }

  const settings = sessionSettingsOf(session);
  const defaults = scopeDefaultsOf(rt);
  const workspace = settings.workspace ?? defaults.workspace;

  let tools: ToolFramework;
  let sandbox: ReviewSandbox | null = null;
  /**
   * ★ 先建沙箱、再建作用域。
   *
   *   顺序反了的话，路径守卫拿不到沙箱根，`run_command` 会被**无条件拒绝** ——
   *   而下面的审查提示词又明确教模型用它跑测试，结果每次审查都白撞一次，
   *   "在临时副本里跑测试"这个承诺实际不成立。
   *
   *   沙箱建不出来（磁盘满、权限不足）时如实降级：那次审查只是不能跑命令。
   */
  try {
    sandbox = await createReviewSandbox(workspace);
  } catch (err) {
    sandbox = null;
    console.warn(
      `[review] 临时副本不可用：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const scope = await createChatToolScope({
      log: rt.bootstrapped.log,
      clock: rt.clock,
      workspace,
      // 与主对话相同的读取/分析工具，但审查固定只读。
      permission: 'read-only',
      dataDir: dataDirOf(rt),
      appRoot: process.cwd(),
      baseTools: rt.tools,
      documentSearch: {
        search: async (query, limit) =>
          (await getKnowledgeService().search(query, limit)).hits,
      },
      ...(sandbox !== null ? { commandRoot: sandbox.root } : {}),
    });
    tools = scope.tools;
    if (sandbox !== null) tools.register(sandbox.runCommand);
  } catch (err) {
    // 作用域建不出来时把已经复制好的副本清掉，避免 temp 泄漏
    await sandbox?.cleanup().catch(() => undefined);
    return NextResponse.json(
      { error: `审查工作区不可用：${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  const transcript = selected
    .map((turn, index) => {
      const trace = turn.trace.length > 0
        ? `\n该轮工具轨迹摘要：${turn.trace}`
        : '';
      const stateLine =
        turn.state === 'interrupted'
          ? '已中断（只有部分产出）'
          : turn.legacy
            ? '完成（早期执行者格式）'
            : '完成';
      return `## 选中轮次 ${index + 1}\n轮次状态：${stateLine}\n用户：${turn.userText}\n\n助手：${turn.assistantText}${trace}`;
    })
    .join('\n\n');

  const system = [
    '你是一个独立审查 Agent。',
    '你可以使用工具读取真实文件、文档和可用资料，但禁止写文件、改代码、删除、移动、执行有副作用的外部操作。',
    '审查对象是用户选中的轮次，不是摘要。',
    '如果某轮标记为“已中断”，只审查已生成的部分，明确指出内容不完整、无法验证的部分，不要假设缺失内容。',
    '如果某轮标记为“早期执行者格式”，它是历史回复，按历史交付物审查，不要把它当成当前管家角色。',
    '要主动取证：读文件、检查实现、核对数据和标准、检查跨轮一致性；需要时使用工具。',
    '需要验证代码时，使用 run_command 在临时副本里跑测试/构建；它不会写入用户工作区，命令结束后临时副本会删除。',
    'run_command 只允许 node / npm / npx / pnpm / yarn / tsc / vitest / git / python，并且只能在临时副本目录里执行；不要尝试别的命令，也不要试图切换目录到副本之外。',
    '先从证据出发写出一份完整的审查报告正文（Markdown），包含结论、问题、证据、影响、建议和无法验证的部分。',
    '报告正文就是最终交付物：写完正文后直接结束，不要再调用任何“提交”工具，也不要在正文后再补一段总结。',
    '不要用固定判据模板凑数，不要声称执行过你没有执行的操作。',
    '单一审查者：不要模拟多角色投票，也不要输出“多视角”套话。',
  ].join('\n');

  const user = [
    `会话：${session.title}`,
    `工作区：${workspace}`,
    `审查范围：${selected.length} 个选中轮次`,
    '',
    transcript,
    '',
    '请先判断还需要什么证据，再使用工具取证，最后直接给出完整审查报告。',
  ].join('\n');

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      const collectedTraces: ReviewTrace[] = [];
      const onProgress = (event: AgentProgressEvent): void => {
        switch (event.kind) {
          case 'roundStarted':
            send('round', { round: event.round });
            break;
          case 'reasoning':
            send('reasoning', {
              round: event.round,
              delta: event.delta,
              accumulated: event.accumulated,
            });
            break;
          case 'text':
            send('text', {
              round: event.round,
              delta: event.delta,
              accumulated: event.accumulated,
            });
            break;
          case 'toolCall':
            send('tool_call', {
              round: event.round,
              callId: event.callId,
              name: event.name,
              argsDelta: event.argsDelta,
              partial: event.partial,
            });
            break;
          case 'toolStarted':
            send('tool_started', {
              round: event.round,
              callId: event.callId,
              name: event.name,
            });
            break;
          case 'toolResult': {
            const trace: ReviewTrace = {
              round: event.round,
              toolName: event.name,
              output: event.output.slice(0, 4000),
              ok: event.ok,
              denied: event.denied,
              durationMs: event.durationMs,
            };
            collectedTraces.push(trace);
            send('tool_result', {
              ...trace,
              output: event.output.slice(0, 2000),
            });
            break;
          }
          case 'usage':
            send('usage', {
              round: event.round,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalInputTokens: event.totalInputTokens,
              totalOutputTokens: event.totalOutputTokens,
            });
            break;
          case 'finished':
            send('finished', {
              rounds: event.rounds,
              reason: event.reason,
            });
            break;
        }
      };

      const streamPort: ModelStreamPort | undefined = rt.streamModel ?? undefined;
      send('started', {
        sessionId,
        turnIds: selected.map((t) => t.assistantId),
        model: reviewModel.describe().model,
        streamed: streamPort !== undefined,
      });

      try {
        const result = await runAgentLoop(
          {
            model: reviewModel,
            tools,
            log: rt.bootstrapped.log,
            clock: rt.clock,
            taskId: sessionId,
            task: `审查会话 ${sessionId} 的 ${selected.length} 个轮次`,
            signal: req.signal,
            onProgress,
            ...(streamPort !== undefined ? { streamPort } : {}),
          },
          [msg.system(system), msg.user(user)],
        );

        const markdown = result.finalText.trim();
        if (markdown.length === 0) {
          throw new Error('审查 Agent 没有返回报告正文');
        }
        const summary = legacySummary(markdown) || markdown.slice(0, 180);
        const traces = result.traces.map(toReviewTrace);
        const run = chat.appendReviewRun({
          sessionId,
          turnIds: selected.map((turn) => turn.assistantId),
          status: 'completed',
          model: reviewModel.describe().model,
          promptVersion: 'review-agent.v4',
          snapshotHash: selected.map((t) => t.assistantId).join(','),
          stages: [
            { name: 'context', status: 'done' },
            { name: 'agent', status: 'done' },
          ],
          report: {
            summary,
            markdown,
          },
          traces,
          usage: result.usage,
        });
        send('completed', {
          ok: true,
          run,
          finalText: markdown,
          traces,
          rounds: result.rounds,
          usage: result.usage,
          turns: selected.map((t) => ({
            messageId: t.assistantId,
            summary,
            criteria: 0,
          })),
        });
      } catch (err) {
        const aborted = req.signal.aborted === true;
        const messageText = aborted ? '审查已取消' : err instanceof Error ? err.message : String(err);
        let runId: string | undefined;
        try {
          const failed = chat.appendReviewRun({
            sessionId,
            turnIds: selected.map((turn) => turn.assistantId),
            status: aborted ? 'aborted' : 'failed',
            model: reviewModel.describe().model,
            promptVersion: 'review-agent.v4',
            snapshotHash: selected.map((t) => t.assistantId).join(','),
            stages: [
              { name: 'context', status: 'done' },
              { name: 'agent', status: 'failed' },
            ],
            report: null,
            traces: collectedTraces,
            usage: { inputTokens: 0, outputTokens: 0 },
            error: messageText,
          });
          runId = failed.id;
        } catch {
          // 记录失败不阻断错误事件
        }
        send('error', { error: messageText, runId, aborted });
      } finally {
        if (sandbox !== null) await sandbox.cleanup();
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
