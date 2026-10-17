/**
 * 验证 10：低置信度**不再阻断**（v7 · D-4）
 *
 * ★★ 本验证要证明一件产品级的事：
 *
 *   旧实现：`if (!confident) return { steps: [], reports: [] }`
 *           → 回复「置信度不足，已转入澄清提问，未执行派发。」
 *           → **整轮什么都没做**（用户实测撞到过，去忙回来一看还是空的）
 *
 *   新实现：带着最可能的判断**照常干活**，并把假设明说出来
 *           → 用户看到的是「结果 + 我按 X 理解的，不对说一声」
 *
 * ⚠️ 为什么要用**假模型**而不是真模型：
 *   真模型什么时候给出低置信度**不可控**，无法稳定复现这条路径。
 *   假模型能把它钉死 —— 这是"可验证"而不是"碰运气"。
 *
 * ⚠️ 假模型只覆盖 **路由** 这一个结构化调用（故意给 0.2）；
 *   其余结构化调用返回合法的最小结果，让流程能跑完。
 *   所以本验证测的是**「低置信度时流程仍然走完」**，
 *   而不是"产出质量"——后者由 validate:1/8 用真模型负责。
 */

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { msg } from '../core/ports/model.js';
import type {
  ModelPort,
  ModelResponse,
  StructuredCall,
  StructuredResult,
} from '../core/ports/model.js';
import { runSession, buildRouteAssumption } from '../core/runtime/orchestrator.js';

// ═══════════════════════════════════════════════════════════
// 断言框架
// ═══════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}
function hr(title: string): void {
  console.log(`\n${'─'.repeat(66)}\n${title}\n${'─'.repeat(66)}`);
}

// ═══════════════════════════════════════════════════════════
// 假模型：路由永远给低置信度，其余照常
// ═══════════════════════════════════════════════════════════

/**
 * 按 `schemaName` 分流返回假数据。
 *
 * ⚠️ 这里刻意**不 import 真实 schema** —— 验证脚本不该因为
 *    schema 加字段而失败。它只关心"流程有没有走完"。
 */
function makeStubModel(opts: {
  readonly confidence: number;
  readonly clarifyingQuestion?: string;
}): ModelPort & { readonly calls: string[] } {
  const calls: string[] = [];

  const stub: ModelPort = {
    complete: (): Promise<ModelResponse> => {
      // ⚠️ 显式标注类型 —— `toolCalls: []` 会被推断成 `never[]`，
      //    在 strict 下与 `readonly ModelToolCallPart[]` 不兼容
      const res: ModelResponse = {
        text: '（假模型的自由文本）',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'stub-low-confidence',
      };
      return Promise.resolve(res);
    },

    completeStructured: <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
      const name = call.schemaName ?? 'unknown';
      calls.push(name);

      const usage = { inputTokens: 10, outputTokens: 5 };

      // ① 路由 → 故意低置信度
      if (name === 'RoutingDecision') {
        return Promise.resolve({
          value: {
            servant: 'life',
            confidence: opts.confidence,
            reason: '用户的话太短，看不出具体要做什么',
            ...(opts.clarifyingQuestion !== undefined
              ? { clarifyingQuestion: opts.clarifyingQuestion }
              : {}),
          } as unknown as T,
          usage,
          attempts: 1,
          promptVersion: 'test',
        });
      }

      // ② 任务契约（v7 · D-5，取代旧的 DispatchPlan）
      //
      // ⚠️ v7：这里原先是 `DispatchPlan`（拆解成多步派发）。
      //    现在只有一个执行者，改为契约 —— 桩模型必须跟着变，
      //    否则 `writeContract` 拿不到 `criteria`，会在 `.filter` 上崩。
      if (name === 'TaskContract') {
        return Promise.resolve({
          value: {
            deliverable: '给一个最简单可行的建议',
            criteria: ['给出一条可执行的建议'],
            mustObey: [],
            domains: ['none'],
          } as unknown as T,
          usage,
          attempts: 1,
          promptVersion: 'test',
        });
      }

      // ③ 仆人汇报
      if (name === 'ServantReport') {
        return Promise.resolve({
          value: {
            reply: '先按最朴素的做法给你一个方案。',
            status: 'done',
            artifacts: [],
            uncertainties: [],
            findings: [],
          } as unknown as T,
          usage,
          attempts: 1,
          promptVersion: 'test',
        });
      }

      // ④ 监督
      if (name === 'SupervisionOutput') {
        return Promise.resolve({
          value: { conflicts: [], summary: '无冲突' } as unknown as T,
          usage,
          attempts: 1,
          promptVersion: 'test',
        });
      }

      // 其余：给一个空对象，让流程继续（不追求语义正确）
      return Promise.resolve({
        value: {} as unknown as T,
        usage,
        attempts: 1,
        promptVersion: 'test',
      });
    },

    describe: () => ({
      provider: 'stub',
      model: 'stub-low-confidence',
      capabilities: {
        supportsVision: false,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
      },
    }),
  } as unknown as ModelPort;

  return Object.assign(stub, { calls });
}

// ═══════════════════════════════════════════════════════════
const T0 = 1_760_000_000_000;
const clock = new FixedClock(T0);

console.log('\n▶ 验证 10：低置信度不再阻断（D-4）\n');

hr('① 纯函数层：假设的文案');

const noAssume = buildRouteAssumption(true, { servant: 'life', confidence: 0.9 });
check('置信度足够 → 没有假设', noAssume === undefined);

const withAssume = buildRouteAssumption(false, { servant: 'health', confidence: 0.3 });
check('置信度不足 → 有假设', withAssume !== undefined);
check('★ 假设里先说"干了什么"（让用户知道不是空转）', withAssume?.note.includes('先按') === true);
check('★ 不含内部术语', withAssume?.note.includes('置信度') === false);

hr('② ★★ 关键：低置信度时 runSession 仍然派发执行');

const lowModel = makeStubModel({ confidence: 0.2, clarifyingQuestion: '你是想问晚饭还是想问买菜？' });
const log1 = new EventLog('v10_low');

let result: Awaited<ReturnType<typeof runSession>> | undefined;
let threw: string | undefined;
try {
  result = await runSession({
    model: lowModel,
    log: log1,
    clock,
    sessionId: 'v10_low',
    userGoal: '那个',
    recalled: [],
  });
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}

check('runSession 没有抛异常', threw === undefined, threw?.slice(0, 40));
check('确实调了路由与契约', lowModel.calls.includes('RoutingDecision') && lowModel.calls.includes('TaskContract'), lowModel.calls.join(','));

if (result !== undefined) {
  check(
    '★★ 低置信度**仍然写了契约**（旧实现这里 0 步、什么都不干）',
    result.contract !== undefined,
    result.contract !== undefined ? 'contract 已写下' : 'contract 缺失',
  );
  check(
    '★★ 低置信度**仍然有执行产出**（旧实现这里是 0）',
    result.reports.length > 0,
    `reports=${result.reports.length}`,
  );
  check('confident 如实为 false（不写死 true）', result.confident === false);
  check('★★ assumption 存在（把假设告诉用户，而不是停下来问）', result.assumption !== undefined);
  check('★ 假设把 clarifyingQuestion 转成了纠正入口', result.assumption?.note.includes('你其实是想问') === true);
}

hr('③ 事件语义正确（审计看到的不再是"什么都没做"）');

const assumed = log1.byType('route.assumed');
const clarified = log1.byType('route.clarify');
check('★ 落了 route.assumed 事件', assumed.length === 1);
check('★★ 不再落 route.clarify（旧语义是"停下来问"）', clarified.length === 0);
check(
  '事件里带 wouldHaveAsked（保留了"本来想问什么"的可审计性）',
  (assumed[0]?.payload as { wouldHaveAsked?: unknown } | undefined)?.wouldHaveAsked !== undefined,
);

hr('④ 对照：高置信度时行为不变');

const highModel = makeStubModel({ confidence: 0.95 });
const log2 = new EventLog('v10_high');
const high = await runSession({
  model: highModel,
  log: log2,
  clock,
  sessionId: 'v10_high',
  userGoal: '帮我安排晚饭',
  recalled: [],
});

check('高置信度时 assumption 为空', high.assumption === undefined);
check('高置信度时 confident 为 true', high.confident === true);
check('高置信度时不落 route.assumed', log2.byType('route.assumed').length === 0);
check('高置信度时照常执行', high.reports.length > 0 && high.contract !== undefined, `${high.reports.length} 份汇报`);

// ═══════════════════════════════════════════════════════════
hr('结果');

console.log(`  通过 ${passed}/${passed + failed}`);
if (failed > 0) {
  console.log(`  ✗ 失败 ${failed} 项`);
  console.log('\n▶ 验证 10 未通过\n');
  process.exit(1);
}
console.log('\n▶ 验证 10 通过：低置信度带着假设继续干，不再空转\n');

// 抑制未使用告警（msg 导入是给将来扩展用的）
void msg;
