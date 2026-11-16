/**
 * 验证 17：附件解析与"附件进记忆"（E1/E2）
 *
 * ★ 本验证要证明六件事（都是"多模态真的接上了"的前提）：
 *
 *   ① **图片能被解析成结构化字段**（不是只有类型、没有实现）
 *   ② **不支持视觉时，模型调用次数为 0** —— 这条最要紧：
 *      实测 `deepseek-v4-pro` 收到图片**不报错**，HTTP 200，
 *      只在正文里回一句"抱歉，我无法查看这张图片"。
 *      不先查能力，这个降级会**无声发生**。
 *   ③ **同一规则命中多个同义字段时只产出一条候选**（真实调用抓到过重复）
 *   ④ **候选必须过审**：入库后是 `candidate`，不是 `active`
 *   ⑤ **留痕不含原始内容**：`attachment.parsed` 里没有品牌名/摘要正文
 *   ⑥ **失败不抛异常**：返回可读原因，主流程不受影响
 *
 * ⚠️ 判据先说清（避免事后找理由）：
 *   · ② 用 `countByPurpose` 断言**零调用**，而不是"没看到日志"
 *   · ③ 用真实出现过的 `merchant` + `brand` 组合，不用构造的假数据
 *   · ⑤ 用 `JSON.stringify` 全量搜索，不用"肉眼看着没有"
 *
 * ★ 全程用 `MockModel`（确定性、不需真实 API），因此可纳入长期回归。
 */

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { MemoryStore } from '../core/memory/store.js';
import { MockModel, respondError, respondJson } from '../adapters/model/mock.js';
import { parseAttachment } from '../core/multimodal/parse.js';
import { sinkAndAdmit } from '../core/reflection/runReflection.js';
import { candidateScopeFor, classifyAttachment, routeAttachment } from '../core/multimodal/attach.js';
import { classifyInputFromDataUrl } from '../core/multimodal/dataUrl.js';
import type { ModelCapabilities } from '../core/ports/model.js';

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

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

const T0 = 1_760_000_000_000;
const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/**
 * ★ 这份响应**复现真实模型给过的东西**：
 *   实测 `deepseek-flash` 对一张星巴克小票返回了
 *   `merchant` 与 `brand` 两个同义键 —— 于是旧代码产出两条"常购品牌"。
 */
const REAL_LOOKING_OUTPUT = {
  fields: {
    merchant: 'STARBUCKSCOFFEE',
    brand: 'Starbucks',
    category: 'Coffee',
    total: '38.00 CNY',
    date: '2026-10-18',
  },
  summary: '这是一张星巴克咖啡的消费凭证截图，包含品牌、类别、金额与日期信息。',
};

function makeModel(opts?: {
  vision?: boolean;
  output?: unknown;
  error?: string;
}): MockModel {
  const capabilities: ModelCapabilities = {
    supportsVision: opts?.vision ?? true,
    supportsStreaming: false,
    supportsTools: false,
  } as ModelCapabilities;

  return new MockModel({
    capabilities,
    ...(opts?.error !== undefined
      ? { script: [respondError(opts.error, 'attachmentParse')] }
      : { script: [respondJson(opts?.output ?? REAL_LOOKING_OUTPUT, 'attachmentParse')] }),
  });
}

function setup() {
  const log = new EventLog('__event_log_17__');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, 'local');
  return { log, clock, store };
}

async function main(): Promise<void> {
  hr('① 图片能被解析成结构化字段');
  {
    const { log, clock } = setup();
    const model = makeModel();
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a1',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });

    check('解析成功', r.ok);
    if (r.ok) {
      check('抽到品牌字段', r.parsed.fields['brand'] === 'Starbucks', `brand=${r.parsed.fields['brand']}`);
      check('摘要非空', r.parsed.summary.length > 0);
      check('记录了模型标识', r.parsed.model.length > 0, `model=${r.parsed.model}`);
      check('记录了 token 用量', r.parsed.usage.inputTokens > 0);
    }
    check('模型被调用 1 次', model.countByPurpose('attachmentParse') === 1);
  }

  hr('② 不支持视觉 → **一次模型调用都没有**');
  {
    const { log, clock } = setup();
    const model = makeModel({ vision: false });
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a2',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });

    check('返回失败', !r.ok);
    if (!r.ok) check('原因说明"不支持读图"', r.reason.includes('不支持读图'), r.reason.slice(0, 30));
    // ★ 关键断言：不是"没看到调用日志"，而是**计数为 0**
    check('模型调用次数 = 0', model.countByPurpose('attachmentParse') === 0);
  }

  hr('③ 同义字段去重（真实调用抓到过重复）');
  {
    const { log, clock } = setup();
    const r = await parseAttachment({
      model: makeModel(),
      log,
      clock,
      attachmentId: 'a3',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });

    check('解析成功', r.ok);
    if (r.ok) {
      const brandCands = r.candidates.filter((c) => c.content.startsWith('常购品牌'));
      check('品牌类候选只有 1 条', brandCands.length === 1, `实际 ${brandCands.length} 条`);
      check(
        '取值确定（更短的干净品牌名）',
        brandCands[0]?.content === '常购品牌：Starbucks',
        brandCands[0]?.content,
      );
      check('理由里说明了已合并', (brandCands[0]?.rationale ?? '').includes('已合并'));
      check('候选总数不超过规则条数（4）', r.candidates.length <= 4, `${r.candidates.length} 条`);
    }
  }

  hr('④ 候选必须过审（入库后是 candidate，不是 active）');
  {
    const { log, clock, store } = setup();
    const model = makeModel();
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a4',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });

    if (!r.ok) {
      check('解析成功（前置）', false);
    } else {
      const now = clock.now();
      const sunk = await sinkAndAdmit({
        log,
        store,
        clock,
        model,
        candidates: r.candidates.map((c, i) => ({
          id: `cand_17_${i}`,
          kind: c.kind,
          content: c.content,
          confidence: c.confidence,
          evidence: c.evidence,
          scope: { memClass: 'global_shared' as const },
          rationale: c.rationale,
          layer: 'domain' as const,
          by: 'butler' as const,
          createdAt: now,
        })),
      });

      check('确实入库了', sunk.created > 0, `${sunk.created} 条`);
      const all = store.all();
      check('全部处于候选态', all.every((e) => e.lifecycle === 'candidate'));
      check('没有一条被直接生效', all.every((e) => e.lifecycle !== 'active'));
      check('落 memory.candidate 事件', log.byType('memory.candidate').length > 0);
    }
  }

  hr('⑤ 留痕不含原始内容（隐私）');
  {
    const { log, clock } = setup();
    await parseAttachment({
      model: makeModel(),
      log,
      clock,
      attachmentId: 'a5',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });

    const events = log.byType('attachment.parsed');
    check('落了 attachment.parsed 事件', events.length === 1);
    const dumped = JSON.stringify(events[0]?.payload ?? {});
    check('不含品牌名', !dumped.includes('Starbucks'));
    check('不含摘要正文', !dumped.includes('消费凭证'));
    check('含字段个数（可审计）', dumped.includes('fieldCount'));
  }

  hr('⑥ 失败不抛异常，返回可读原因');
  {
    const { log, clock } = setup();
    const r = await parseAttachment({
      model: makeModel({ error: '模型超时' }),
      log,
      clock,
      attachmentId: 'a6',
      kind: 'receipt',
      fileName: 'receipt.png',
      source: { kind: 'image', url: DATA_URL },
    });
    check('返回失败而不是抛错', !r.ok);
    if (!r.ok) check('原因里带上了模型错误', r.reason.includes('模型超时'));
  }

  hr('⑦ 文本附件不要求视觉能力');
  {
    const { log, clock } = setup();
    const model = makeModel({ vision: false, output: { fields: { brand: 'BrandA' }, summary: '一段笔记' } });
    const r = await parseAttachment({
      model,
      log,
      clock,
      attachmentId: 'a7',
      kind: 'document',
      fileName: 'note.txt',
      source: { kind: 'text', text: '今天买了 BrandA 的咖啡，38 元' },
    });
    check('解析成功（无视觉能力也能做）', r.ok);
    check('模型确实被调用了', model.countByPurpose('attachmentParse') === 1);
  }

  hr('⑧ 领域路由（§5.3：收据 → 健康领域）');
  {
    /**
     * ⚠️ 这条以前**永远走不到**：`kind` 被写死 `'image'`、`scope` 写死 `global_shared`，
     *    于是 `classifyAttachment` / `routeAttachment` 生产 0 调用，
     *    「收据 → 健康领域」只存在于文档里。
     */
    const receiptRoute = routeAttachment({ kind: 'receipt', needsUserConfirmation: false });
    check('收据 → health', receiptRoute.domain === 'health', String(receiptRoute.domain));
    check(
      '候选落 health 领域（不是全局共享）',
      JSON.stringify(candidateScopeFor(receiptRoute)) ===
        JSON.stringify({ memClass: 'domain', domain: 'health' }),
      JSON.stringify(candidateScopeFor(receiptRoute)),
    );

    const imgRoute = routeAttachment({ kind: 'image', needsUserConfirmation: false });
    check('用途不明的图片 → 不猜领域', imgRoute.domain === null);
    check('并给出反问', (imgRoute.question ?? '').length > 0);
    check(
      '候选落全局共享（待确认）',
      JSON.stringify(candidateScopeFor(imgRoute)) === JSON.stringify({ memClass: 'global_shared' }),
    );

    // 真实 PNG 魔数 → 按内容识别（而不是靠文件名）
    const input = classifyInputFromDataUrl(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      '附件1',
    );
    check('能还原出分类入参', input !== null);
    if (input !== null) {
      const cls = classifyAttachment(input);
      check('按魔数识别出 image/png', cls.detectedMime === 'image/png', String(cls.detectedMime));
    }
  }

  hr('结果');
  console.log(`  通过 ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log(`  ✗ 失败 ${failed} 项`);
    console.log('\n▶ 验证 17 未通过\n');
    process.exit(1);
  }
  console.log('\n▶ 验证 17 通过：附件解析成立（能力门禁 / 去重 / 待审核 / 不泄漏）\n');
}

await main();


