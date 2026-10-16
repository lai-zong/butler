/**
 * 验证 8 · 真实使用路径（浏览器走的同一条路）
 *
 * ★★ 这个验证补的是一个**方法论缺口**，比它测的功能更重要。
 *
 *   之前 7 个验证脚本测的都是"能力可用"：
 *     · 验证 1 手工调 `runSession`
 *     · 验证 2 手工调反思与入库
 *     · 验证 3 手工装配工具与策略
 *
 *   ⚠️ 而**浏览器走的是 `runTurn`** ——
 *      没有人测它。后果是这一轮连续发现三个缺口，
 *      **每一个都只在真实使用路径上暴露**：
 *
 *        ① 对话历史从没进模型上下文（跨轮指代失败）
 *        ② `tools` 从没装配到界面（仆人根本不调工具）
 *        ③ 工具调用分片按错键聚合（参数全空、20 轮烧光 token）
 *
 *      这三个在单元测试里全过 —— 因为单元测试测的是**零件**，
 *      而它们是**接线**问题。
 *
 *   ★ 所以本验证的定位是：**测接线，不测零件**。
 *     它调用 `runTurn`（浏览器调的那个函数），
 *     断言完整链路的可观测结果。
 *
 * 通过条件（每条都对应一个真实踩过的坑）：
 *   ① 事实提取把安全约束存成 `global_constraint`（不是 global_shared）
 *   ② 事实自主生效（`decidedBy=system`）—— 用户要求"不要用户审核"
 *   ③ 第二轮能召回第一轮的事实（跨轮可用）
 *   ④ 工具循环真的调用了工具，且**参数正确**（分片聚合对）
 *   ⑤ 工具过程落进消息（刷新后能看到）
 *   ⑥ 硬约束被注入给仆人
 *
 * 运行：pnpm validate:8
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeepSeekModel, deepSeekConfigFromEnv } from '../adapters/model/deepseek.js';
import { DeepSeekStream } from '../adapters/model/deepseekStream.js';
import { SystemClock } from '../adapters/clock/system.js';
import { SeededRandom } from '../core/ports/clock.js';
import { EventLog } from '../core/events/log.js';
import { MemoryStore } from '../core/memory/store.js';
import { SessionStore } from '../core/chat/types.js';
import { runTurn } from '../core/chat/service.js';
import { ToolFramework } from '../core/tools/framework.js';
import { fileTools } from '../core/tools/builtin/file.js';
import { submitReportTool } from '../core/tools/builtin/report.js';
import { NodeFileSystem } from '../adapters/fs/node.js';
import type { ActionTier, PermissionPolicy } from '../core/tools/types.js';
import type { AgentProgressEvent } from '../core/tools/agentLoop.js';

const line = (s = ''): void => console.log(s);
const hr = (t: string): void => {
  line();
  line('─'.repeat(72));
  line(`  ${t}`);
  line('─'.repeat(72));
};

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  checks.push({ name, pass, detail });
};

const USER = 'u_validate8';

/** 只读放行、写拒绝 —— 与网页同一套策略。 */
class AutoReadPolicy implements PermissionPolicy {
  isRemembered(): boolean {
    return false;
  }
  isTierEnabled(t: ActionTier): boolean {
    return t !== 'dangerous';
  }
  async ask(): Promise<'allow'> {
    return 'allow';
  }
}

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 8 · 真实使用路径（runTurn —— 浏览器走的同一条路）' + ' '.repeat(13) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const cfg = deepSeekConfigFromEnv();
  const dir = await mkdtemp(join(tmpdir(), 'butler-validate8-'));
  line(`  工作目录：${dir}`);

  try {
    // 造一个仆人需要读的文件
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, '冰箱盘点.txt'),
      '鸡蛋 5 个\n北豆腐 1 盒\n花生酱 1 瓶\n西兰花 1 颗\n',
      'utf8',
    );

    const clock = new SystemClock();
    const log = new EventLog('v8');
    const store = new MemoryStore(log, clock, USER);
    const chat = new SessionStore(log, clock, USER);
    const session = chat.createSession('v8_session');

    const model = new DeepSeekModel(cfg);
    /** ⚠️ 叙述用独立模型 —— 轻活用便宜的即可（官方两个模型都支持思考） */
    const streamModel = new DeepSeekStream({ ...cfg, model: 'deepseek-flash' });

    const tools = new ToolFramework({ log, clock, policy: new AutoReadPolicy() });
    tools.registerAll(fileTools(new NodeFileSystem({ root: dir })));
    tools.register(submitReportTool(), { overwrite: true });

    // ═══════════════════════════════════════════════════════
    hr('第一轮：陈述身份与安全约束 + 要求用工具读文件');
    // ═══════════════════════════════════════════════════════

    const progress: AgentProgressEvent[] = [];
    const turn1 = await runTurn({
      sessionId: session.id,
      userText: '我叫示例用户，对花生严重过敏。读一下 冰箱盘点.txt，告诉我里面哪些我不能吃。用工具读。',
      userId: USER,
      random: new SeededRandom(8),
      model,
      streamModel,
      log,
      clock,
      store,
      chat,
      tools,
      onAgentProgress: (e) => progress.push(e),
    });

    const toolResults = progress.filter((e) => e.kind === 'toolResult');
    const toolCalls = progress.filter((e) => e.kind === 'toolCall' && !e.partial);
    const fileRead = toolResults.find((e) => e.kind === 'toolResult' && e.name === 'read_file');

    line(`  轮次：${turn1.session.routing.servant} · 判定 ${turn1.verdict.outcome}`);
    line(`  工具调用 ${toolCalls.length} 次 · 结果 ${toolResults.length} 个`);
    for (const e of toolResults) {
      if (e.kind !== 'toolResult') continue;
      line(`    ${e.ok ? '✓' : '✗'} ${e.name} ${e.output.length} 字（${e.durationMs}ms）`);
    }

    // ④ 工具真的被调用，且参数正确（分片聚合对）
    check('④ 工具循环真的调用了工具', toolCalls.length > 0, `${toolCalls.length} 次`);
    check(
      '④ ★ read_file 成功（参数正确 —— 分片聚合没出错）',
      fileRead !== undefined && fileRead.kind === 'toolResult' && fileRead.ok,
      fileRead !== undefined && fileRead.kind === 'toolResult'
        ? `${fileRead.output.length} 字`
        : '未调用 read_file',
    );
    check(
      '④ ★ 没有耗尽轮次（聚合错时会烧到上限）',
      progress.some((e) => e.kind === 'finished' && e.reason === 'terminalTool'),
    );

    // ═══════════════════════════════════════════════════════
    hr('② 事实提取与分级');
    // ═══════════════════════════════════════════════════════

    const memories = store.all();
    const allergyMem = memories.find((m) => m.content.includes('花生'));
    const nameMem = memories.find((m) => m.content.includes('示例用户'));

    line(`  记忆库 ${memories.length} 条：`);
    for (const m of memories.slice(0, 8)) {
      line(`    [${m.memClass}] ${m.lifecycle} ${m.content.slice(0, 40)}`);
    }

    check('① 提取出过敏事实', allergyMem !== undefined);
    check(
      '① ★ 过敏存为 global_constraint（硬约束）—— 否则保护会失效',
      allergyMem !== undefined && allergyMem.memClass === 'global_constraint',
      allergyMem?.memClass ?? '未找到',
    );
    check(
      '① 名字存为 global_shared（软约束，不该占用硬约束名额）',
      nameMem !== undefined && nameMem.memClass === 'global_shared',
      nameMem?.memClass ?? '未找到',
    );

    const approved = log.byType('memory.approved');
    const autoApproved = approved.filter(
      (e) => (e.payload as { decidedBy?: string }).decidedBy === 'system',
    );
    check(
      '② ★ 事实自主生效（用户要求「不要用户审核」）',
      autoApproved.length > 0,
      `${autoApproved.length} / ${approved.length} 条自主`,
    );

    // ═══════════════════════════════════════════════════════
    hr('③ 跨轮指代与召回');
    // ═══════════════════════════════════════════════════════

    const turn2 = await runTurn({
      sessionId: session.id,
      userText: '就按刚才说的来。另外简单说说今晚还要注意什么。',
      userId: USER,
      random: new SeededRandom(8),
      model,
      streamModel,
      log,
      clock,
      store,
      chat,
      tools,
    });

    const recalls = log.byType('memory.recalled');
    const lastRecall = recalls[recalls.length - 1];
    const recallCount =
      lastRecall !== undefined && typeof lastRecall.payload === 'object' && lastRecall.payload !== null
        ? ((lastRecall.payload as { count?: number }).count ?? 0)
        : 0;

    line(`  第二轮召回 ${recallCount} 条`);
    line(`  回复前 200 字：${turn2.replyText.slice(0, 200).replace(/\n/g, ' ')}`);

    check('③ ★ 第二轮召回到第一轮的记忆', recallCount > 0, `${recallCount} 条`);
    check(
      '③ 回复里体现了「记得」（提到过敏或花生）',
      /花生|过敏/.test(turn2.replyText),
    );

    // ═══════════════════════════════════════════════════════
    hr('⑤ 工具过程落进消息（刷新后可见）');
    // ═══════════════════════════════════════════════════════

    const msgs = chat.messagesOf(session.id);
    const butlerMsgs = msgs.filter((m) => m.role === 'butler');
    const withTrace = butlerMsgs.filter((m) => m.agentTrace !== undefined);

    line(`  管家消息 ${butlerMsgs.length} 条 · 含工具过程 ${withTrace.length} 条`);
    if (withTrace[0]?.agentTrace !== undefined) {
      const t = withTrace[0].agentTrace;
      line(`    ${t.rounds.length} 轮：`);
      for (const r of t.rounds) {
        line(`      第 ${r.round} 轮：思考 ${r.reasoning.length} 字 · ${r.toolCalls.length} 次调用`);
      }
    }

    check('⑤ ★ 工具过程落进消息', withTrace.length > 0);
    check(
      '⑤ 落盘事件里也带 trace（刷新/重启后能恢复）',
      log
        .byType('session.message')
        .some((e) => (e.payload as { agentTrace?: unknown }).agentTrace !== undefined),
    );

    // ═══════════════════════════════════════════════════════
    hr('⑥ 硬约束注入');
    // ═══════════════════════════════════════════════════════

    const injections = log.byType('constraint.injected');
    const hardInjections = injections.filter(
      (e) => (e.payload as { source?: string }).source === 'global_constraint',
    );

    line(`  注入 ${injections.length} 次 · 其中硬约束 ${hardInjections.length} 次`);
    for (const e of hardInjections.slice(0, 3)) {
      const p = e.payload as { servant?: string; content?: string; reason?: string };
      line(`    → ${p.servant}：${p.content}（${p.reason}）`);
    }

    check('⑥ ★ 硬约束被注入给仆人', hardInjections.length > 0, `${hardInjections.length} 次`);

    // ═══════════════════════════════════════════════════════
    hr('结果汇总');
    // ═══════════════════════════════════════════════════════

    const passed = checks.filter((c) => c.pass).length;
    for (const c of checks) {
      line(`  ${c.pass ? '✓' : '✗'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
    }
    line();
    line(`  通过 ${passed}/${checks.length}`);
    line();
    line('  ★ 本验证与其它 7 个的区别 —— **它测接线，不测零件**：');
    line('    调用的是 `runTurn`（浏览器走的那条路），');
    line('    而这一轮发现的三个缺口（历史没进上下文 / tools 没装配 /');
    line('    分片聚合错）**全都只在真实路径上暴露**，单元测试全过。');
    line();

    const allPass = passed === checks.length;
    line(allPass ? '  ▶ 验证 8 通过：真实使用路径成立' : '  ▶ 验证 8 未通过：见上方 ✗ 项');
    line();

    // 保留事件文件供人工查看
    const dump = join(dir, 'events.jsonl');
    await writeFile(dump, log.all().map((e) => JSON.stringify(e)).join('\n'), 'utf8');
    const size = (await readFile(dump, 'utf8')).length;
    line(`  事件流已导出：${dump}（${log.length} 条 · ${size} 字节）`);

    await rm(dir, { recursive: true, force: true });
    process.exit(allPass ? 0 : 1);
  } catch (err) {
    line();
    line(`  ✗ 执行失败：${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) line(err.stack.split('\n').slice(1, 6).join('\n'));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  line(`致命错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
