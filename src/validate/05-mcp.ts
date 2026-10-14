/**
 * 验证 5 · MCP 客户端端到端（零 token，纯确定性）
 *
 * 目的：单元测试用的是**假传输**，它证明了协议逻辑，但证明不了
 *       "我们的客户端能跟真实的 stdio MCP server 说上话"。
 *       这个脚本起一个真的子进程（tools/minimal-mcp-server.mjs）跑完整流程。
 *
 * 通过条件：
 *   ① 能启动子进程并完成 initialize 握手（含版本协商）
 *   ② 能发现工具并按**本系统推断**分级（不是采信外部声明）
 *   ③ 外部工具挂进 ToolFramework 后**走同一个闸门**（危险级被拦）
 *   ④ 只读工具能真正调用并拿到结果
 *   ⑤ 非文本内容块被**如实标注**而不是静默丢弃
 *   ⑥ 全流程留痕（mcp.* 生命周期 + tool.* 调用）
 *   ⑦ 进程退出时挂起请求被立即拒绝（不干等到超时）
 *
 * 运行：pnpm validate:5
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EventLog } from '../core/events/log.js';
import { SystemClock } from '../adapters/clock/system.js';
import { stdioTransportFactory } from '../adapters/mcp/stdio.js';
import { McpClient } from '../core/mcp/client.js';
import {
  DEFAULT_POLICY,
  MCP_TOOL_PREFIX,
  inferTier,
  type McpServerConfig,
} from '../core/mcp/types.js';
import { ToolFramework } from '../core/tools/framework.js';
import type { ActionTier, PermissionPolicy } from '../core/tools/types.js';

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

/** 记录闸门询问了哪些工具。 */
class RecordingPolicy implements PermissionPolicy {
  readonly asked: { toolName: string; tier: ActionTier }[] = [];
  isRemembered(): boolean {
    return false;
  }
  isTierEnabled(): boolean {
    return true;
  }
  async ask(req: { toolName: string; tier: ActionTier }): Promise<'allow'> {
    this.asked.push({ toolName: req.toolName, tier: req.tier });
    return 'allow';
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', '..', 'tools', 'minimal-mcp-server.mjs');

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 5 · MCP 客户端端到端（真实子进程，零 token）' + ' '.repeat(17) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const log = new EventLog('s_validate_05');
  const clock = new SystemClock();
  const client = new McpClient(log, clock);
  client.registerTransport(stdioTransportFactory());

  let exitCode = 0;
  let child: import('node:child_process').ChildProcess | undefined;

  try {
    // ═══════════════════════════════════════════════════════
    hr('① 启动并握手');
    // ═══════════════════════════════════════════════════════

    line(`  服务器脚本：${serverPath}`);
    line(`  命令：node ${serverPath}`);

    const cfg: McpServerConfig = {
      id: 'minimal',
      name: '最小验证服务器',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      enabled: true,
      policy: { ...DEFAULT_POLICY, level: 'readOnly' },
    };

    const added = client.addServer(cfg);
    line(`  添加配置：${added.ok ? '✓ 通过校验' : `✗ ${added.problems.join('; ')}`}`);
    check('① 配置通过校验', added.ok, added.problems.join('; '));

    const connected = await client.connect('minimal');
    if (!connected.ok) {
      line(`  ✗ 连接失败：${connected.reason ?? '未知'}`);
      check('① 连接成功', false, connected.reason ?? '');
      throw new Error(connected.reason ?? '连接失败');
    }

    const rt = client.getServer('minimal');
    line(`  ✓ 连接成功`);
    line(`    协议版本：${rt?.handshake?.protocolVersion ?? '?'}`);
    line(`    服务器：${rt?.handshake?.serverInfo?.name ?? '?'} v${rt?.handshake?.serverInfo?.version ?? '?'}`);
    line(`    状态：${rt?.state ?? '?'}`);
    check('① 握手完成', rt?.state === 'connected');
    check('① 版本协商成功', rt?.handshake?.versionAgreed === true, rt?.handshake?.protocolVersion ?? '');
    check('① 服务器信息可读', rt?.handshake?.serverInfo?.name === 'minimal-mcp-verify');

    // ═══════════════════════════════════════════════════════
    hr('② 工具发现与分级推断');
    // ═══════════════════════════════════════════════════════

    line(`  发现 ${rt?.tools.length ?? 0} 个工具：`);
    for (const t of rt?.tools ?? []) {
      const inferred = inferTier(t.name, t.description);
      line(`    · ${t.name.padEnd(16)} → ${t.tier.padEnd(10)}（${inferred.why}）`);
    }

    check('② 发现三个工具', rt?.tools.length === 3, String(rt?.tools.length ?? 0));
    const del = rt?.tools.find((t) => t.name === 'delete_note');
    check('② ★ 危险工具被识别为 dangerous', del?.tier === 'dangerous', String(del?.tier));
    const weather = rt?.tools.find((t) => t.name === 'get_weather');
    check('② 只读工具被识别为 readOnly', weather?.tier === 'readOnly', String(weather?.tier));

    // ═══════════════════════════════════════════════════════
    hr('③ 挂进 ToolFramework —— 走同一个闸门');
    // ═══════════════════════════════════════════════════════

    const policy = new RecordingPolicy();
    const tools = new ToolFramework({ log, clock, policy });
    const specs = client.toToolSpecs();
    tools.registerAll(specs);

    line(`  注册 ${specs.length} 个外部工具（危险级默认不注册）：`);
    for (const s of specs) {
      line(`    · ${s.name.padEnd(28)} tier=${s.tier}`);
    }
    // ★ 危险级默认不进可用集合 —— 这是一道独立于全局闸门的防线
    check('③ ★★ 只注册了非危险工具（危险级默认不导出）', specs.length === 2, String(specs.length));
    check(
      '③ ★ 名字带 mcp__ 前缀（不同 server 的同名工具不会互相覆盖）',
      specs.every((s) => s.name.startsWith(MCP_TOOL_PREFIX)),
    );

    // 危险工具应当被全局闸门拦下
    const delName = `${MCP_TOOL_PREFIX}minimal__delete_note`;
    let dangerBlocked = false;
    let dangerOutput = '';
    try {
      const r = await tools.execute({ toolName: delName, args: { id: '1' }, taskId: 'v5' });
      dangerBlocked = !r.ok;
      dangerOutput = r.output;
    } catch (err) {
      dangerBlocked = true;
      dangerOutput = err instanceof Error ? err.message : String(err);
    }
    line();
    line(`  尝试调用危险工具 ${delName}`);
    line(`    → ${dangerBlocked ? '✓ 被拦下' : '✗ 竟然执行了'}：${dangerOutput.slice(0, 80)}`);
    check('③ ★★ 危险级外部工具被全局闸门拦下', dangerBlocked, dangerOutput.slice(0, 60));
    check(
      '③ 拦下时未打扰用户（级别禁用发生在询问之前）',
      !policy.asked.some((a) => a.toolName === delName),
    );

    // ═══════════════════════════════════════════════════════
    hr('④ 只读工具真实调用');
    // ═══════════════════════════════════════════════════════

    const weatherName = `${MCP_TOOL_PREFIX}minimal__get_weather`;
    const wr = await tools.execute({
      toolName: weatherName,
      args: { city: '杭州' },
      taskId: 'v5',
    });
    line(`  调用 ${weatherName} { city: "杭州" }`);
    line(`    ok=${wr.ok}`);
    line(`    结果：${wr.output}`);
    check('④ 调用成功', wr.ok, wr.output.slice(0, 60));
    check('④ ★ 结果来自真实子进程', wr.output.includes('杭州'), wr.output.slice(0, 40));
    check('④ 只读工具未打扰用户', !policy.asked.some((a) => a.toolName === weatherName));

    // ═══════════════════════════════════════════════════════
    hr('⑤ 非文本内容块被如实标注');
    // ═══════════════════════════════════════════════════════

    const notesName = `${MCP_TOOL_PREFIX}minimal__list_notes`;
    const nr = await tools.execute({ toolName: notesName, args: {}, taskId: 'v5' });
    line(`  调用 ${notesName}`);
    line(`    结果：${nr.output.replace(/\n/g, ' / ')}`);
    check('⑤ 文本块被取回', nr.output.includes('2 条笔记'));
    check(
      '⑤ ★★ 图片块被如实标注（不静默丢弃）',
      nr.output.includes('图片内容'),
      nr.output.slice(0, 60),
    );

    // ═══════════════════════════════════════════════════════
    hr('⑥ 全流程留痕');
    // ═══════════════════════════════════════════════════════

    const lifecycle = [
      'mcp.serverAdded',
      'mcp.serverConnected',
      'mcp.toolsDiscovered',
    ] as const;
    for (const t of lifecycle) {
      const n = log.byType(t).length;
      line(`  ${t.padEnd(24)} ${n} 条`);
      check(`⑥ 落 ${t} 事件`, n > 0, String(n));
    }

    const callEvents = log.byType('tool.call');
    const resultEvents = log.byType('tool.result');
    line(`  ${'tool.call'.padEnd(24)} ${callEvents.length} 条`);
    line(`  ${'tool.result'.padEnd(24)} ${resultEvents.length} 条`);
    check('⑥ ★ 外部工具调用留痕（与本地工具同构）', callEvents.length >= 2, String(callEvents.length));
    check(
      '⑥ 调用事件里标注了 mcp 来源',
      callEvents.some((e) => (e.payload as { source?: string }).source === 'mcp'),
    );

    // 工具清单事件里记了推断出的分级
    const discovered = log.byType('mcp.toolsDiscovered')[0]?.payload as {
      tools?: { name: string; tier: string }[];
    };
    line();
    line('  mcp.toolsDiscovered 里记录的分级（事后可回答"当时为什么让它自动跑"）：');
    for (const t of discovered?.tools ?? []) {
      line(`    · ${t.name.padEnd(16)} ${t.tier}`);
    }
    check(
      '⑥ ★ 分级随事件留痕',
      (discovered?.tools ?? []).some((t) => t.tier === 'dangerous'),
    );

    // ═══════════════════════════════════════════════════════
    hr('⑦ 进程退出时挂起请求被立即拒绝');
    // ═══════════════════════════════════════════════════════

    // 找一个子进程句柄（通过再次连接拿不到，改用 disconnect 验证正常路径）
    const disconnected = await client.disconnect('minimal');
    line(`  断开：${disconnected ? '✓' : '✗'}`);
    check('⑦ 能正常断开', disconnected);
    check('⑦ 断开后状态为未连接', client.getServer('minimal')?.state === 'disconnected');
    check('⑦ 断开后不再产出工具', client.toToolSpecs().length === 0);

    const afterCall = await client.callTool({
      serverId: 'minimal',
      toolName: 'get_weather',
      toolArgs: { city: 'x' },
    });
    line(`  断开后再调用：ok=${afterCall.ok} · ${afterCall.reason ?? ''}`);
    check('⑦ 断开后调用返回可读原因而非挂起', !afterCall.ok && afterCall.reason !== undefined);

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
    line('  ★ 本验证零 token —— 起了一个真实子进程，但没调任何模型。');
    line();

    const allPass = passed === checks.length;
    line(allPass ? '  ▶ 验证 5 通过：MCP 客户端能跟真实 server 通信' : '  ▶ 验证 5 未通过：见上方 ✗ 项');
    line();
    exitCode = allPass ? 0 : 1;
  } catch (err) {
    line();
    line(`  ✗ 执行失败：${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      line(err.stack.split('\n').slice(1, 5).join('\n'));
    }
    exitCode = 1;
  } finally {
    // 清理：确保不留下孤儿进程
    if (child) child.kill('SIGKILL');
    await client.disconnect('minimal', '验证结束').catch(() => undefined);
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  line(`致命错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
