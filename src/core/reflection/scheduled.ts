/**
 * 定时反思（每日 / 每周）—— A10 的"周期总结"这一环
 *
 * ★★ 这一节之前**完全空转**：
 *   - `reflectTurn`（按轮反思）**已接在 chat service 里**（每轮对话结束就跑）
 *   - 但调度器的 `ctx.reflect` **没有任何实现** ——
 *     所以 `dailyReflection` / `weeklyReview` 两个定时任务
 *     跑起来只会返回「未接入反思引擎」
 *
 *   本文件补的就是"定时反思"这条路。
 *
 * ⚠️ 一个必须如实说明的**数据局限**：
 *
 *   执行汇报被持久化在助手消息的 `servantReports` 里（`service.ts:436`），
 *   但那是**可持久化形状**（`ExecutionReportData`），且 `artifacts` 的 `kind`
 *   是宽松的 `string`；而 `reflectDomain` 要的是核心形状 `ExecutionReport`
 *   （`kind` 是封闭联合）。
 *
 *   所以这里**只把可确定的部分搬过去**：任务 id、状态、汇报正文。
 *   产出物与发现的**结构化细节不参与定时反思** ——
 *   它们在执行当时已经被监督员逐条核对过了，这里不重复搬一遍，
 *   也不做"猜着转"的类型断言（猜错会让反思基于错材料）。
 */

import { DOMAIN_IDS, type DomainId } from '../domain/types.js';
import type { ExecutionArtifact, ExecutionReport } from '../execution/types.js';
import type { SessionStore } from '../chat/types.js';
import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { ModelPort } from '../ports/model.js';
import type { MemoryStore } from '../memory/store.js';
import { reflectButler, reflectDomain, type MemoryCandidate } from './reflect.js';
import { sinkAndAdmit } from './runReflection.js';

/** 从持久化数据里能确定的材料 */
export interface ReportMaterial {
  readonly domain: DomainId;
  readonly taskId: string;
  readonly status: 'done' | 'failed' | 'blocked';
  /** 汇报正文（`reply`）—— 这次执行的结论 */
  readonly summary: string;
  /** 产出物的**可持久化形状**（宽松 kind，用于喂反思的 `summarizeReport`）*/
  readonly artifacts?: readonly {
    readonly kind: string;
    readonly label?: string;
    readonly text?: string;
    readonly itemCount?: number;
  }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 时间窗：每日看最近 24 小时，每周看最近 7 天 */
export function windowMsFor(scope: 'daily' | 'weekly'): number {
  return scope === 'daily' ? DAY_MS : 7 * DAY_MS;
}

function asDomain(v: unknown): DomainId | undefined {
  return typeof v === 'string' && (DOMAIN_IDS as readonly string[]).includes(v)
    ? (v as DomainId)
    : undefined;
}

/**
 * 收集时间窗内的执行汇报材料。
 *
 * ⚠️ 判不出领域的汇报**丢弃**（不硬塞一个默认领域）——
 *    编造归属会让领域反思看到不属于它的材料，违反 §3.2 的作用域隔离。
 */
export function collectRecentReports(args: {
  readonly chat: SessionStore;
  readonly now: number;
  readonly since: number;
}): readonly ReportMaterial[] {
  const out: ReportMaterial[] = [];
  for (const session of args.chat.listSessions()) {
    for (const msg of args.chat.messagesOf(session.id)) {
      if (msg.createdAt < args.since || msg.createdAt > args.now) continue;
      for (const r of msg.servantReports ?? []) {
        const domain = asDomain(r.servant);
        if (domain === undefined) continue;
        out.push({
          domain,
          taskId: r.taskId,
          status: r.status,
          summary: r.reply,
          artifacts: (r.artifacts ?? []).map((a) => ({
            kind: a.kind,
            text: a.text,
            ...(a.itemCount > 0 ? { itemCount: a.itemCount } : {}),
          })),
        });
      }
    }
  }
  return out;
}

/** 把材料包成 `reflectDomain` 要的核心形状 */
function toExecutionReport(m: ReportMaterial): ExecutionReport {
  /**
   * ★★ 关键：`summarizeReport`（reflect.ts:389）**只用 `artifacts` 与 `findings`，
   *    完全忽略 `reply`**。
   *
   * ⚠️ 所以第一版把两者留空是错的 —— 定时反思会看到每条汇报都是「(无产出）」，
   *    等于拿空气做反思（测试直接抓到了：提示词里搜不到汇报正文）。
   *
   * 这里如实搬运：
   *   ① 持久化里的每个产出物 → 转成 `text` 产出物（保留 text/条数）
   *   ② **汇报正文也作为一段文本产出物**（它是这次执行的结论，反思必须看到）
   */
  const artifacts: ExecutionArtifact[] = [];
  for (const a of m.artifacts ?? []) {
    const count = a.itemCount ?? 0;
    const parts = [a.text ?? '', count > 0 ? `（${count} 项）` : ''];
    const text = parts.filter((s) => s.length > 0).join('');
    if (text.length > 0) artifacts.push({ kind: 'text', content: text });
  }
  if (m.summary.trim().length > 0) {
    artifacts.push({ kind: 'text', content: `汇报：${m.summary}` });
  }

  return {
    taskId: m.taskId,
    domain: m.domain,
    status: m.status,
    reply: m.summary,
    artifacts,
    memoryRefs: [],
    uncertainties: [],
    findings: [],
  };
}

export interface ReflectScheduledArgs {
  readonly scope: 'daily' | 'weekly';
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly chat: SessionStore;
  readonly userId: string;
  /** 反思材料的"任务目标"描述（默认按周期生成）*/
  readonly userGoal?: string;
}

export interface ReflectScheduledResult {
  readonly candidateCount: number;
  readonly summary: string;
}

/**
 * 跑一次定时反思。
 *
 * - **daily**：按领域分组做**领域层**反思（§3.2 作用域隔离：每个领域只看自己的材料）
 * - **weekly**：做**管家层**跨领域复盘
 */
export async function reflectScheduled(args: ReflectScheduledArgs): Promise<ReflectScheduledResult> {
  const now = args.clock.now();
  const since = now - windowMsFor(args.scope);
  const materials = collectRecentReports({ chat: args.chat, now, since });

  if (materials.length === 0) {
    return { candidateCount: 0, summary: `最近${args.scope === 'daily' ? '一天' : '七天'}没有执行记录，跳过反思` };
  }

  const userGoal =
    args.userGoal ??
    (args.scope === 'daily' ? '总结今天做过的事，提炼可复用的经验' : '复盘这一周，找出跨领域的规律');

  const candidates: MemoryCandidate[] = [];
  const parts: string[] = [];

  if (args.scope === 'daily') {
    // 按领域分组 —— 每组只喂自己的材料（作用域隔离）
    const byDomain = new Map<DomainId, ReportMaterial[]>();
    for (const m of materials) {
      const list = byDomain.get(m.domain) ?? [];
      list.push(m);
      byDomain.set(m.domain, list);
    }

    for (const [domain, list] of byDomain) {
      const r = await reflectDomain({
        model: args.model,
        log: args.log,
        clock: args.clock,
        input: {
          domain,
          userGoal,
          ownReports: list.map(toExecutionReport),
          ownDomainMemories: args.store
            .list({ domain })
            .map((e) => ({
              id: e.id,
              kind: e.kind,
              content: e.content,
              lifecycle: e.lifecycle,
            })),
          feedback: [],
        },
      });
      candidates.push(...r.candidates);
      parts.push(`${domain} 领域 ${r.candidates.length} 条`);
    }
  } else {
    const r = await reflectButler({
      model: args.model,
      log: args.log,
      clock: args.clock,
      input: {
        reports: materials.map((m) => ({ domain: m.domain, summary: m.summary })),
        conflicts: [],
        globalMemories: args.store
          .list({})
          .filter((e) => e.memClass === 'global_constraint' || e.memClass === 'global_shared')
          .map((e) => ({ id: e.id, kind: e.kind, content: e.content, lifecycle: e.lifecycle })),
        existingPrinciples: args.store
          .list({})
          .filter((e) => e.kind === 'principle')
          .map((e) => ({
            id: e.id,
            content: e.content,
            applied: e.effectiveness?.applied ?? 0,
            succeeded: e.effectiveness?.succeeded ?? 0,
          })),
        userGoal,
        temporalPatterns: [],
      },
    });
    candidates.push(...r.candidates);
    parts.push(`跨领域 ${r.candidates.length} 条`);
  }

  /**
   * 入库：复用按轮反思的入口（`sinkAndAdmit`）——
   * 它已经处理了去重、自主采纳与"待审核"分流。
   * ⚠️ 定时反思产出的候选**同样要过审核**，不能因为"是系统自己跑的"就自动生效。
   */
  const sunk = sinkAndAdmit({
    log: args.log,
    store: args.store,
    clock: args.clock,
    candidates,
  });

  return {
    candidateCount: sunk.created,
    summary:
      `材料 ${materials.length} 条（${parts.join('，')}）；` +
      `入库 ${sunk.created} 条（自主采纳 ${sunk.admittedAutonomously}，待审核 ${sunk.pendingReview}，` +
      `重复跳过 ${sunk.skippedDuplicates}）`,
  };
}
