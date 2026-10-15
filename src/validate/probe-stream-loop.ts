/**
 * 探针：流式工具循环是否真的产生「思考 → 工具 → 再思考」画面
 *
 * 要回答（全部靠实测）：
 *   ① 流式路径能否正确**拼接工具调用参数**（这是最容易错的地方）
 *   ② 工具是否真的被执行、结果是否回喂
 *   ③ 进度事件的顺序与内容是否构成 dsh/codex 那种画面
 *   ④ 与非流式相比，工具调用的正确性是否退化
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeepSeekModel, deepSeekConfigFromEnv } from '../adapters/model/deepseek.js';
import { DeepSeekStream } from '../adapters/model/deepseekStream.js';
import { SystemClock } from '../adapters/clock/system.js';
import { EventLog } from '../core/events/log.js';
import { ToolFramework } from '../core/tools/framework.js';
import { fileTools } from '../core/tools/builtin/file.js';
import { submitReportTool } from '../core/tools/builtin/report.js';
import { runAgentLoop } from '../core/tools/agentLoop.js';
import { servantSystem, servantTask } from '../core/prompts/butler.js';
import { NodeFileSystem } from '../adapters/fs/node.js';
import type { PermissionPolicy } from '../core/tools/types.js';
import type { ActionTier } from '../core/tools/types.js';
import { msg } from '../core/ports/model.js';

const cfg = deepSeekConfigFromEnv();
const clock = new SystemClock();

const dir = await mkdtemp(join(tmpdir(), 'probe-stream-loop-'));
await writeFile(join(dir, 'inventory.txt'), '冰箱现有：鸡蛋 5 个、北豆腐 1 盒、糙米 半袋\n', 'utf8');

const log = new EventLog('probe');
/**
 * ⚠️ 必须给策略，否则写操作会等人确认而挂住。
 *    照验证 3 的做法本地实现（它是那份脚本里的私有类，没有导出）。
 */
class AutoApprove implements PermissionPolicy {
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

const tools = new ToolFramework({ log, clock, policy: new AutoApprove() });

const fsPort = new NodeFileSystem({ root: dir });
tools.registerAll(fileTools(fsPort));
tools.register(submitReportTool(), { overwrite: true });

const messages = [
  msg.system(servantSystem('life')),
  msg.user(
    servantTask({
      instruction: '读取 inventory.txt，看看冰箱里有什么，然后给出还需要采购的清单，最后用 submit_report 提交。',
      injectedConstraints: [],
    }),
  ),
];

for (const mode of ['stream', 'nonstream'] as const) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  模式：${mode === 'stream' ? '流式（streamPort）' : '非流式（model.complete）'}`);
  console.log('═'.repeat(62));

  const events: string[] = [];
  let reasoningTotal = 0;
  let textTotal = 0;
  const t0 = Date.now();

  const streamPort = mode === 'stream' ? new DeepSeekStream({ ...cfg, model: 'deepseek-flash' }) : undefined;

  const result = await runAgentLoop(
    {
      model: new DeepSeekModel(cfg),
      tools,
      log,
      clock,
      taskId: `probe_${mode}`,
      terminalTool: 'submit_report',
      ...(streamPort !== undefined ? { streamPort } : {}),
      onProgress: (e) => {
        switch (e.kind) {
          case 'roundStarted':
            events.push(`── 第 ${e.round}/${e.maxRounds} 轮 ──`);
            break;
          case 'reasoning':
            reasoningTotal = e.accumulated.length;
            break;
          case 'text':
            textTotal = e.accumulated.length;
            break;
          case 'toolCall':
            if (!e.partial) events.push(`  ▸ 调用 ${e.name}`);
            break;
          case 'toolStarted':
            events.push(`    ⚙ 执行 ${e.name}`);
            break;
          case 'toolResult':
            events.push(
              `    ${e.denied ? '⛔ 被拒' : e.ok ? '✓' : '✗'} ${e.name} 结果 ${e.output.length} 字（${e.durationMs}ms）`,
            );
            break;
          case 'finished':
            events.push(`── 结束：${e.reason} · ${e.rounds} 轮 ──`);
            break;
        }
      },
    },
    messages,
  );

  console.log(events.join('\n'));
  console.log('');
  console.log(`  轮次：${result.rounds}  工具调用：${result.traces.length} 次`);
  console.log(`  最终文本：${result.finalText.length} 字`);
  console.log(`  累计思考：${reasoningTotal} 字  累计正文：${textTotal} 字`);
  console.log(`  耗时：${Date.now() - t0} ms`);
  console.log(`  用量：输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens}`);
  console.log('');
  console.log('  工具调用明细：');
  for (const tr of result.traces) {
    console.log(`    · ${tr.toolName}  ok=${tr.ok}  参数键=${Object.keys((tr.args ?? {}) as object).join(',')}`);
  }
}

await rm(dir, { recursive: true, force: true });
