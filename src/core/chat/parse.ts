/**
 * 持久化数据的**解析**（不是断言）
 *
 * ★★ 这个文件是被一次**真实崩溃**逼出来的。
 *
 *   事故经过（有服务器日志与落盘数据为证）：
 *     · 我给仆人产出加了必填字段 `reply`
 *     · 首页随即 500：`Cannot read properties of undefined (reading 'length')`
 *       at `ServantPanel` → `cur.reply.length`
 *     · 查落盘数据：6 份仆人产出**全部没有 `reply` 字段**
 *       （`events.jsonl` 写于 02:45，加字段是 18:45 —— 旧数据）
 *
 *   ⚠️ 根因不是"忘了改界面"，而是**恢复路径只信任、不校验**：
 *
 *     ```ts
 *     ...(Array.isArray(p['servantReports'])
 *       ? { servantReports: p['servantReports'] as ExecutionReportData[] }
 *       : {}),
 *     ```
 *
 *     它只检查"是不是数组"，然后用 `as` 断言贴上类型标签。
 *     数据里没有的字段，类型系统**再也不会管** ——
 *     因为断言是单向的：编译器相信你，运行时不。
 *
 * ★★ 由此得到一条必须守住的纪律：
 *
 *   > **跨持久化边界的数据是不可信输入，必须逐字段校验。**
 *   > 旧版本代码写下的数据，与新版本的假设**必然不一致**。
 *
 *   ⚠️ 这类 bug 的特征是"只在老用户身上出现"：
 *      新装的机器永远复现不了（没有旧数据），
 *      而老用户一打开就崩 —— 最难查的一类。
 *
 * ⚠️ 与校验库的区别：这里**不用 schema 库做严格校验**，而是
 *    "缺字段就补默认值"。理由：这是**恢复历史数据**，
 *    目标是"尽可能读出来"，不是"不符合就拒绝"。
 *    丢弃一条历史消息，比显示一条字段不全的消息更糟。
 */

import type { AgentTraceData, ExecutionReportData } from './types.js';

/** 判断是不是普通对象（不是 null、不是数组）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 解析仆人产出数组。
 *
 * ⚠️ 返回 `undefined` 的语义是「这条消息里没有（或读不出）仆人产出」——
 *    界面据此**整块不渲染**，而不是渲染一堆空字段。
 */
export function parseExecutionReports(v: unknown): ExecutionReportData[] | undefined {
  if (!Array.isArray(v)) return undefined;

  const out: ExecutionReportData[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;

    /**
     * ⚠️ 必须先取局部变量再判定，不能在三元/spead 里就地收窄 ——
     *    `exactOptionalPropertyTypes` 下编译器不会把
     *    「三元里非 undefined」这个事实带到属性类型上，
     *    于是 `{ agentTrace: X | undefined }` 不满足 `{ agentTrace?: X }`。
     *    取局部变量后 `!== undefined` 的收窄才生效。
     */
    const trace = parseAgentTrace(raw['agentTrace']);
    const decision = raw['needsButlerDecision'];

    out.push({
      servant: str(raw['servant']),
      taskId: str(raw['taskId']),
      status:
        raw['status'] === 'failed' || raw['status'] === 'blocked' ? raw['status'] : 'done',
      /**
       * ★★ 这里就是事故点。
       *
       *   `reply` 是后加的字段；旧数据里没有它。
       *   补空串 → 界面走「这次没有留下说明」的兜底分支。
       *
       * ⚠️ **不能**在这里编一句假话（例如"（无说明）"）——
       *    那会与真人写的 reply 混在一起，用户分不清哪些是模型说的。
       */
      reply: str(raw['reply']),
      instruction: str(raw['instruction']),
      ...(trace !== undefined ? { agentTrace: trace } : {}),
      artifacts: (Array.isArray(raw['artifacts']) ? raw['artifacts'] : [])
        .filter(isRecord)
        .map((a) => ({
          kind: str(a['kind']),
          text: str(a['text']),
          itemCount: num(a['itemCount']),
        })),
      findings: (Array.isArray(raw['findings']) ? raw['findings'] : [])
        .filter(isRecord)
        .map((f) => ({
          kind: str(f['kind']),
          statement: str(f['statement']),
          evidence: strArray(f['evidence']),
        })),
      uncertainties: strArray(raw['uncertainties']),
      ...(typeof decision === 'string' ? { needsButlerDecision: decision } : {}),
      injectedConstraints: (Array.isArray(raw['injectedConstraints'])
        ? raw['injectedConstraints']
        : []
      )
        .filter(isRecord)
        .map((c) => ({
          content: str(c['content']),
          // ⚠️ 缺字段时按「不可协商」处理：**保守方向**
          //    （把软约束误当硬约束，只是提示多一句；
          //      反过来会让真正的硬约束被当成可放宽的）
          negotiable: bool(c['negotiable']) ? true : false,
        })),
    });
  }

  return out.length > 0 ? out : undefined;
}

/** 解析工具循环过程。⚠️ 形状不符就整体丢弃（界面上没有过程比有半截过程好）。 */
export function parseAgentTrace(v: unknown): AgentTraceData | undefined {
  if (!isRecord(v)) return undefined;

  const rawRounds = v['rounds'];
  if (!Array.isArray(rawRounds)) return undefined;

  // ⚠️ 类型里是 readonly 数组，不能直接 push —— 先用可变局部变量攒
  const rounds: {
    round: number;
    reasoning: string;
    text: string;
    toolCalls: {
      callId: string;
      name: string;
      argsText: string;
      ok: boolean;
      denied: boolean;
      output: string;
      durationMs: number;
    }[];
  }[] = [];
  for (const r of rawRounds) {
    if (!isRecord(r)) continue;
    rounds.push({
      round: num(r['round']),
      reasoning: str(r['reasoning']),
      text: str(r['text']),
      toolCalls: (Array.isArray(r['toolCalls']) ? r['toolCalls'] : [])
        .filter(isRecord)
        .map((t) => ({
          callId: str(t['callId']),
          name: str(t['name']),
          argsText: str(t['argsText']),
          ok: bool(t['ok']),
          denied: bool(t['denied']),
          output: str(t['output']),
          durationMs: num(t['durationMs']),
        })),
    });
  }

  if (rounds.length === 0) return undefined;

  const fin = v['finished'];
  const rawUsage = v['usage'];
  const usage =
    isRecord(rawUsage) &&
    typeof rawUsage['inputTokens'] === 'number' &&
    typeof rawUsage['outputTokens'] === 'number'
      ? {
          inputTokens: rawUsage['inputTokens'],
          outputTokens: rawUsage['outputTokens'],
        }
      : undefined;
  return {
    rounds,
    ...(usage !== undefined ? { usage } : {}),
    finished: isRecord(fin)
      ? {
          rounds: num(fin['rounds']),
          reason: str(fin['reason']),
        }
      : null,
  };
}
