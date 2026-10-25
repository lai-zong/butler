/**
 * 工具框架与安全闸门测试
 *
 * ★ 这个文件最重要的不是"工具能不能跑通"，
 *   而是**"能不能绕过闸门"** —— 每一条测试都试图从某个角度绕过去。
 */

import { describe, expect, it, vi } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { fileTools } from '../builtin/file.js';
import { ToolFramework } from '../framework.js';
import { WebPermissionPolicy } from '../../../app/server/permission.js';
import {
  containsCredentials,
  credentialPatternLabels,
  redactArgs,
  redactText,
} from '../redact.js';
import { ToolError, type ActionTier, type Authorization, type PermissionPolicy } from '../types.js';

const T0 = 1_760_000_000_000;

/** 可编程策略：测试里精确控制"用户会怎么答"。 */
class TestPolicy implements PermissionPolicy {
  private remembered = new Set<string>();
  private enabled = new Set<ActionTier>(['readOnly', 'normal', 'highRisk']);
  readonly asked: { toolName: string; tier: ActionTier; summary: string; preview?: string }[] = [];

  constructor(private readonly answer: Authorization = 'allow') {}

  isRemembered(toolName: string): boolean {
    return this.remembered.has(toolName);
  }
  remember(toolName: string): void {
    this.remembered.add(toolName);
  }
  enableTier(t: ActionTier): void {
    this.enabled.add(t);
  }
  isTierEnabled(t: ActionTier): boolean {
    return this.enabled.has(t);
  }
  async ask(req: {
    toolName: string;
    tier: ActionTier;
    summary: string;
    preview?: string;
  }): Promise<Exclude<Authorization, 'blocked'>> {
    this.asked.push(req);
    return this.answer === 'blocked' ? 'deny' : this.answer;
  }
}

function setup(answer: Authorization = 'allow') {
  const log = new EventLog('s_tools');
  const clock = new FixedClock(T0);
  const fs = new MemoryFileSystem({ now: T0 });
  const policy = new TestPolicy(answer);
  const fw = new ToolFramework({ log, clock, policy });
  fw.registerAll(fileTools(fs));
  return { log, clock, fs, policy, fw };
}

// ═══════════════════════════════════════════════════════════
// ★ 闸门：任何路径都绕不过
// ═══════════════════════════════════════════════════════════

describe('★ 安全闸门 · 分级判定', () => {
  it('只读工具自动放行，不打扰用户', async () => {
    const { fw, fs, policy } = setup();
    fs.seedFile('a.txt', '你好');

    const r = await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('你好');
    expect(policy.asked).toHaveLength(0); // 没问用户
  });

  it('★ normal 级别必须询问用户', async () => {
    const { fw, policy } = setup();
    await fw.execute({
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
      taskId: 't1',
    });
    expect(policy.asked).toHaveLength(1);
    expect(policy.asked[0]?.tier).toBe('normal');
  });

  it('★ 用户拒绝时工具不执行，且落 action.blocked 事件', async () => {
    const { fw, fs, log } = setup('deny');
    fs.seedFile('a.txt', '原内容');

    await expect(
      fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: '新内容' }, taskId: 't1' }),
    ).rejects.toThrow(ToolError);

    // ★ 关键：文件没被改
    expect(await fs.readText('a.txt')).toBe('原内容');
    expect(log.byType('action.blocked')).toHaveLength(1);
  });

  it('★ dangerous 级别默认禁用（连问都不问）', async () => {
    const { fw, fs, policy } = setup();
    fs.seedFile('a.txt', 'x');

    await expect(
      fw.execute({ toolName: 'remove_path', args: { path: 'a.txt' }, taskId: 't1' }),
    ).rejects.toThrow(/默认禁用/);

    expect(await fs.exists('a.txt')).toBe(true); // 没删掉
    expect(policy.asked).toHaveLength(0); // 根本不该问
  });

  it('用户在设置里开启后，dangerous 才可执行（且仍需确认）', async () => {
    const { fw, fs, policy } = setup();
    fs.seedFile('a.txt', 'x');
    policy.enableTier('dangerous');

    const r = await fw.execute({ toolName: 'remove_path', args: { path: 'a.txt' }, taskId: 't1' });
    expect(r.ok).toBe(true);
    expect(await fs.exists('a.txt')).toBe(false);
    expect(policy.asked).toHaveLength(1);
  });

  it('会话内记住后不再重复询问', async () => {
    const { fw, policy } = setup();
    policy.remember('write_file');
    await fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: '1' }, taskId: 't1' });
    await fw.execute({ toolName: 'write_file', args: { path: 'b.txt', content: '2' }, taskId: 't1' });
    expect(policy.asked).toHaveLength(0);
  });

  it('未知工具被拒绝并留痕', async () => {
    const { fw, log } = setup();
    await expect(
      fw.execute({ toolName: 'nonexistent', args: {}, taskId: 't1' }),
    ).rejects.toThrow(/未知工具/);
    expect(log.byType('action.blocked')).toHaveLength(1);
  });

  it('★ 策略本身抛错时保守拒绝（fail-closed，不是放行）', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const badPolicy: PermissionPolicy = {
      isRemembered: () => false,
      isTierEnabled: () => true,
      ask: async () => {
        throw new Error('策略崩溃了');
      },
    };
    const fw = new ToolFramework({ log, clock, policy: badPolicy });
    fw.registerAll(fileTools(fs));
    fs.seedFile('a.txt', '原');

    await expect(
      fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: '新' }, taskId: 't' }),
    ).rejects.toThrow();
    expect(await fs.readText('a.txt')).toBe('原'); // 没被改
  });
});

// ═══════════════════════════════════════════════════════════
// 只读预览
// ═══════════════════════════════════════════════════════════

describe('只读预览 · 让用户能真正判断', () => {
  it('★ 覆盖已有文件时告诉用户行数变化', async () => {
    const { fw, fs, policy } = setup();
    fs.seedFile('a.txt', '第一行\n第二行\n第三行');

    await fw.execute({
      toolName: 'write_file',
      args: { path: 'a.txt', content: '只有一行' },
      taskId: 't1',
    });

    const preview = policy.asked[0]?.preview ?? '';
    expect(preview).toContain('将覆盖已有文件');
    expect(preview).toContain('原 3 行 → 新 1 行');
  });

  it('新建文件时说明是新建', async () => {
    const { fw, policy } = setup();
    await fw.execute({ toolName: 'write_file', args: { path: 'new.txt', content: 'x' }, taskId: 't1' });
    expect(policy.asked[0]?.preview).toContain('将新建文件');
  });

  it('★ 删除目录时列出将影响的内容（而不是笼统说"会删除"）', async () => {
    const { fw, fs, policy } = setup();
    policy.enableTier('dangerous');
    fs.seedDir('data');
    fs.seedFile('data/a.txt', '1');
    fs.seedFile('data/b.txt', '2');

    await fw.execute({ toolName: 'remove_path', args: { path: 'data', recursive: true }, taskId: 't1' });

    const preview = policy.asked[0]?.preview ?? '';
    expect(preview).toContain('将删除目录');
    expect(preview).toContain('包含 2 项');
    expect(preview).toContain('a.txt');
    expect(preview).toContain('不可恢复');
  });

  it('移动时提示目标已存在', async () => {
    const { fw, fs, policy } = setup();
    fs.seedFile('from.txt', '1');
    fs.seedFile('to.txt', '2');

    await fw.execute({ toolName: 'move_path', args: { from: 'from.txt', to: 'to.txt' }, taskId: 't1' });
    expect(policy.asked[0]?.preview).toContain('目标已存在');
  });

  it('预览失败不阻塞流程（但确实没预览）', async () => {
    const { fw, policy } = setup();
    // remove 的 preview 内部会 stat 失败，但不应导致整个调用失败
    policy.enableTier('dangerous');
    await fw.execute({ toolName: 'remove_path', args: { path: '不存在' }, taskId: 't1' });
    expect(policy.asked).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 审计
// ═══════════════════════════════════════════════════════════

describe('审计 · 全量留痕', () => {
  it('每次调用都产生审计记录', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', 'x');
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });

    const audits = fw.allAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      toolName: 'read_file',
      tier: 'readOnly',
      authorization: 'allow',
      outcome: 'success',
      taskId: 't1',
    });
  });

  it('★ 被拒绝的调用也留审计（拒绝本身是安全信号）', async () => {
    const { fw } = setup('deny');
    await expect(
      fw.execute({ toolName: 'write_file', args: { path: 'a', content: 'b' }, taskId: 't1' }),
    ).rejects.toThrow();

    const audits = fw.allAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe('denied');
    expect(audits[0]?.authorization).toBe('deny');
  });

  it('执行失败也留审计', async () => {
    const { fw } = setup();
    const r = await fw.execute({ toolName: 'read_file', args: { path: '不存在' }, taskId: 't1' });
    expect(r.ok).toBe(false);
    expect(fw.allAudits()[0]?.outcome).toBe('error');
  });

  it('可按任务过滤审计', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', 'x');
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't2' });
    expect(fw.auditsFor('t1')).toHaveLength(1);
    expect(fw.auditsFor('t2')).toHaveLength(1);
  });

  it('动作分级判定落事件（方案 § 11 要求可审计）', async () => {
    const { fw, log } = setup();
    await fw.execute({ toolName: 'write_file', args: { path: 'a', content: 'b' }, taskId: 't1' });
    const ev = log.byType('action.classified');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ toolName: 'write_file', tier: 'normal' });
  });

  it('工具结果落事件', async () => {
    const { fw, fs, log } = setup();
    fs.seedFile('a.txt', 'x');
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    expect(log.byType('tool.result')).toHaveLength(1);
  });

  it('审计回调被触发（供界面实时展示）', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const onAudit = vi.fn();
    const fw = new ToolFramework({ log, clock, policy: new TestPolicy(), onAudit });
    fw.registerAll(fileTools(fs));
    fs.seedFile('a.txt', 'x');
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    expect(onAudit).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 注册纪律
// ═══════════════════════════════════════════════════════════

describe('注册纪律', () => {
  it('★ 重名工具抛错，不允许静默覆盖', () => {
    const { fw, fs } = setup();
    const dup = fileTools(fs)[0];
    if (!dup) throw new Error('no tool');
    expect(() => fw.register(dup)).toThrow(/已注册/);
  });

  it('toModelSpecs 只暴露模型需要的字段', async () => {
    const { fw } = setup();
    const specs = fw.toModelSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(Object.keys(s).sort()).toEqual(['description', 'name', 'parameters']);
      // 不得把 tier / execute 暴露给模型
      expect(s).not.toHaveProperty('tier');
      expect(s).not.toHaveProperty('execute');
    }
  });

  it('可按条件过滤工具（如只给只读工具）', async () => {
    const { fw } = setup();
    const readOnly = fw.toModelSpecs((t) => t.tier === 'readOnly');
    expect(readOnly.every((t) => ['read_file', 'list_dir', 'stat_path'].includes(t.name))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 凭证脱敏
// ═══════════════════════════════════════════════════════════

describe('★ 凭证脱敏（"可用不可见"）', () => {
  it('识别常见密钥形态', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['sk-abcdefghijklmnopqrstuvwxyz', 'OpenAI 风格'],
      ['ghp_abcdefghijklmnopqrstuvwxyz01', 'GitHub Token'],
      ['AKIAIOSFODNN7EXAMPLE', 'AWS Key'],
      ['Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Bearer'],
    ];
    for (const [text, label] of cases) {
      expect(redactText(text), label).toContain('已脱敏');
      expect(redactText(text), label).not.toContain(text.slice(0, 20));
    }
  });

  it('识别手机号与身份证', () => {
    expect(redactText('联系我 13812345678')).toContain('已脱敏:手机号');
    expect(redactText('身份证 110101199001011234')).toContain('已脱敏');
  });

  it('识别键值对形态', () => {
    expect(redactText('password=hunter2secret')).toContain('已脱敏');
    expect(redactText('{"api_key": "abcdef123456"}')).toContain('已脱敏');
    expect(redactText('token: xyz789abc')).toContain('已脱敏');
  });

  it('中文键名也识别', () => {
    expect(redactText('密码=我的秘密口令')).toContain('已脱敏');
    expect(redactText('密钥：abcdefg')).toContain('已脱敏');
  });

  it('不误伤普通文本', () => {
    const normal = '这是一个普通的句子，包含数字 12345 和英文 hello world。';
    expect(redactText(normal)).toBe(normal);
  });

  it('redactArgs 深度遍历对象', () => {
    const out = redactArgs({
      path: '/tmp/a.txt',
      options: { token: 'sk-abcdefghijklmnopqrst', nested: { password: 'secret123' } },
    });
    expect(out).not.toContain('sk-abcdefghijklmnopqrst');
    expect(out).not.toContain('secret123');
    expect(out).toContain('/tmp/a.txt'); // 无害字段保留
  });

  it('redactArgs 截断过长参数', () => {
    const long = redactArgs({ content: 'x'.repeat(1000) }, 100);
    expect(long.length).toBeLessThanOrEqual(101);
  });

  it('containsCredentials 用于记忆写入前检查', () => {
    expect(containsCredentials('我的 API key 是 sk-abcdefghijklmnopqrst')).toBe(true);
    expect(containsCredentials('password: hunter2secret')).toBe(true);
    expect(containsCredentials('我喜欢清淡口味')).toBe(false);
  });

  it('★ 接触凭证的工具，结果被自动脱敏', async () => {
    const { fw } = setup();
    fw.register({
      name: 'read_env',
      description: '读环境变量',
      parameters: { type: 'object', properties: {} },
      tier: 'readOnly',
      touchesCredentials: true,
      summarize: () => '读取环境变量',
      execute: async () => ({
        ok: true,
        output: 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
        durationMs: 1,
      }),
    });

    const r = await fw.execute({ toolName: 'read_env', args: {}, taskId: 't1' });
    expect(r.output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(r.output).toContain('已脱敏');
  });

  it('不接触凭证的工具结果原样返回', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', 'sk-abcdefghijklmnopqrstuvwxyz');
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    // read_file 未标记 touchesCredentials，所以内容原样返回 ——
    // 但这会被审计里的 outputSummary 脱敏兜住
    expect(r.output).toContain('sk-');
  });

  it('★ 审计里的参数与结果都脱敏', async () => {
    const { fw } = setup();
    fw.register({
      name: 'push',
      description: '提交',
      parameters: { type: 'object', properties: {} },
      tier: 'normal',
      summarize: () => '提交代码',
      execute: async () => ({ ok: true, output: 'done', durationMs: 1 }),
    });

    await fw.execute({
      toolName: 'push',
      args: { token: 'sk-abcdefghijklmnopqrstuvwxyz', url: 'https://example.com' },
      taskId: 't1',
    });

    const audit = fw.allAudits()[0];
    expect(audit?.argsSummary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(audit?.argsSummary).toContain('已脱敏');
    expect(audit?.argsSummary).toContain('example.com');
  });

  it('暴露可识别的凭证形态清单（便于文档与测试维护）', () => {
    const labels = credentialPatternLabels();
    expect(labels).toContain('API 密钥');
    expect(labels).toContain('JWT');
    expect(labels).toContain('私钥');
  });
});

// ═══════════════════════════════════════════════════════════
// 文件工具行为
// ═══════════════════════════════════════════════════════════

describe('文件工具 · 行为', () => {
  it('读文件返回内容与行数', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', '第一行\n第二行');
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't' });
    expect(r.ok).toBe(true);
    expect((r.data as { lines: number }).lines).toBe(2);
  });

  it('读不存在的文件返回可读错误（不是抛异常）', async () => {
    const { fw } = setup();
    const r = await fw.execute({ toolName: 'read_file', args: { path: '不存在' }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('路径不存在');
    expect(r.isError).toBe(true);
  });

  it('读目录报错并说明是目录', async () => {
    const { fw, fs } = setup();
    fs.seedDir('d');
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'd' }, taskId: 't' });
    expect(r.output).toContain('目录');
  });

  it('超过最大字节数时报错并给出建议', async () => {
    const { fw, fs } = setup();
    fs.seedFile('big.txt', 'x'.repeat(100));
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'big.txt', maxBytes: 10 }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('超过上限');
  });

  it('列目录区分文件与目录', async () => {
    const { fw, fs } = setup();
    fs.seedDir('d');
    fs.seedFile('d/a.txt', 'x');
    fs.seedDir('d/sub');
    const r = await fw.execute({ toolName: 'list_dir', args: { path: 'd' }, taskId: 't' });
    expect(r.output).toContain('[目录] sub');
    expect(r.output).toContain('a.txt');
  });

  it('参数类型错误时返回可读错误', async () => {
    const { fw } = setup();
    const r = await fw.execute({ toolName: 'read_file', args: { path: 123 }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('path 必须是字符串');
  });

  it('★ 删除目录未声明 recursive 时被拒（安全边界）', async () => {
    const { fw, fs, policy } = setup();
    policy.enableTier('dangerous');
    fs.seedDir('d');
    fs.seedFile('d/a.txt', 'x');

    const r = await fw.execute({ toolName: 'remove_path', args: { path: 'd' }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('需显式递归');
    expect(await fs.exists('d/a.txt')).toBe(true);
  });

  it('写文件后能读回来', async () => {
    const { fw } = setup();
    await fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: '内容' }, taskId: 't' });
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't' });
    expect(r.output).toBe('内容');
  });

  it('stat 区分文件与目录', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', 'abc');
    const r = await fw.execute({ toolName: 'stat_path', args: { path: 'a.txt' }, taskId: 't' });
    expect(r.output).toContain('类型：文件');
    expect(r.output).toContain('大小：3 字节');
  });

  it('移动文件后原路径消失', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', 'x');
    await fw.execute({ toolName: 'move_path', args: { from: 'a.txt', to: 'b.txt' }, taskId: 't' });
    expect(await fs.exists('a.txt')).toBe(false);
    expect(await fs.exists('b.txt')).toBe(true);
  });

  it('★ 不允许删除根目录', async () => {
    const { fw, policy } = setup();
    policy.enableTier('dangerous');
    const r = await fw.execute({ toolName: 'remove_path', args: { path: '/', recursive: true }, taskId: 't' });
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ C6 询问开关：工具真的会停下来问
// ═══════════════════════════════════════════════════════════

describe('★★★ C6 询问开关（工具真的停下来问人）', () => {
  it('★★ 传了 asker 且用户允许 → 动作执行', async () => {
    const { fw, fs } = setup();
    const asked: string[] = [];
    const r = await fw.execute({
      toolName: 'write_file',
      args: { path: 'a.txt', content: '你好' },
      taskId: 't',
      asker: {
        request: async (req) => {
          asked.push(req.summary);
          return true;
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(await fs.readText('a.txt')).toBe('你好');
  });

  it('★★★ 用户拒绝 → 动作**不执行**', async () => {
    const { fw, fs } = setup();
    await expect(
      fw.execute({
        toolName: 'write_file',
        args: { path: 'a.txt', content: '你好' },
        taskId: 't',
        asker: { request: async () => false },
      }),
    ).rejects.toThrow(/拒绝/);
    // 关键：文件**没有**被写
    expect(await fs.exists('a.txt')).toBe(false);
  });

  it('★ 没传 asker → 退回策略默认实现（不崩，行为与改造前一致）', async () => {
    const { fw } = setup('allow');
    const r = await fw.execute({ toolName: 'write_file', args: { path: 'b.txt', content: 'x' }, taskId: 't' });
    expect(r.ok).toBe(true);
  });

  it('★ 只读工具不打扰用户（asker 根本不会被调用）', async () => {
    const { fw, fs } = setup();
    fs.seedFile('a.txt', '你好');
    let called = 0;
    await fw.execute({
      toolName: 'read_file',
      args: { path: 'a.txt' },
      taskId: 't',
      asker: {
        request: async () => {
          called++;
          return true;
        },
      },
    });
    expect(called).toBe(0);
  });

  it('★ 询问时带上只读预览（用户得看到"要动到什么"）', async () => {
    const { fw } = setup();
    let preview: string | undefined;
    await fw.execute({
      toolName: 'write_file',
      args: { path: 'c.txt', content: '内容' },
      taskId: 't',
      asker: {
        request: async (req) => {
          preview = req.preview;
          return true;
        },
      },
    });
    // `write_file` 确实实现了 preview（见 file.ts:157），所以这里必须是字符串
    expect(typeof preview).toBe('string');
    expect(preview).toContain('c.txt');
  });
});

describe('C5 三档模式 · 工具框架真实拦截', () => {
  it('view 连 normal 写工具都拒绝', async () => {
    const log = new EventLog('s_c5_view');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const policy = new WebPermissionPolicy({ mode: 'view' });
    const fw = new ToolFramework({ log, clock, policy });
    fw.registerAll(fileTools(fs));
    await expect(
      fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: 'x' }, taskId: 't1' }),
    ).rejects.toThrow(/当前权限模式 view/);
    expect(await fs.exists('a.txt')).toBe(false);
  });

  it('workspace 允许 normal 写工具（用户批准后）', async () => {
    const log = new EventLog('s_c5_workspace');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const policy = new WebPermissionPolicy({ mode: 'workspace' });
    policy.ask = (async () => 'allow') as unknown as typeof policy.ask;
    const fw = new ToolFramework({ log, clock, policy });
    fw.registerAll(fileTools(fs));
    const r = await fw.execute({ toolName: 'write_file', args: { path: 'a.txt', content: 'x' }, taskId: 't1' });
    expect(r.ok).toBe(true);
    expect(await fs.readText('a.txt')).toBe('x');
  });

  it('full 仍拒绝 dangerous', async () => {
    const log = new EventLog('s_c5_full');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    fs.seedFile('a.txt', 'x');
    const policy = new WebPermissionPolicy({ mode: 'full' });
    const fw = new ToolFramework({ log, clock, policy });
    fw.registerAll(fileTools(fs));
    await expect(
      fw.execute({ toolName: 'remove_path', args: { path: 'a.txt' }, taskId: 't1' }),
    ).rejects.toThrow(/当前权限模式 full/);
    expect(await fs.exists('a.txt')).toBe(true);
  });
});

describe('操作范围熔断 · 框架执行闸门', () => {
  it('窗口内超过非只读调用上限后，下一次真的被拒绝', async () => {
    const log = new EventLog('s_fuse');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    const policy = new TestPolicy('allow');
    const fw = new ToolFramework({
      log,
      clock,
      policy,
      fuse: { windowMs: 60_000, maxWrites: 1 },
    });
    fw.registerAll(fileTools(fs));

    const first = await fw.execute({
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
      taskId: 't_fuse',
    });
    expect(first.ok).toBe(true);

    await expect(
      fw.execute({
        toolName: 'write_file',
        args: { path: 'b.txt', content: 'y' },
        taskId: 't_fuse',
      }),
    ).rejects.toMatchObject({ reason: 'fuse_blocked' });

    expect(await fs.exists('b.txt')).toBe(false);
    expect(log.byType('action.blocked').some((e) => (e.payload as Record<string, unknown>)['reason'] === 'fuse_blocked')).toBe(true);
  });

  it('只读调用不消耗熔断额度', async () => {
    const log = new EventLog('s_fuse_read');
    const clock = new FixedClock(T0);
    const fs = new MemoryFileSystem({ now: T0 });
    fs.seedFile('a.txt', 'x');
    const policy = new TestPolicy('allow');
    const fw = new ToolFramework({
      log,
      clock,
      policy,
      fuse: { windowMs: 60_000, maxWrites: 1 },
    });
    fw.registerAll(fileTools(fs));

    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't_read' });
    await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't_read' });
    // 只读不计数，所以第一次写仍应放行
    const r = await fw.execute({
      toolName: 'write_file',
      args: { path: 'b.txt', content: 'y' },
      taskId: 't_read',
    });
    expect(r.ok).toBe(true);
  });
});

describe('凭证类工具 · 逐次确认', () => {
  it('即使策略记住该工具，也必须每次再问，并留下 credential.used', async () => {
    const log = new EventLog('s_credential_tool');
    const clock = new FixedClock(T0);
    const policy = new TestPolicy('allow');
    const fw = new ToolFramework({ log, clock, policy });
    fw.register({
      name: 'read_secret',
      description: '读取凭证（测试用）',
      parameters: { type: 'object', properties: {} },
      tier: 'readOnly',
      touchesCredentials: true,
      summarize: () => '读取凭证',
      execute: async () => ({ ok: true, output: '[已脱敏:凭证]', durationMs: 1 }),
    });
    policy.remember('read_secret');

    const result = await fw.execute({
      toolName: 'read_secret',
      args: {},
      taskId: 't_secret',
    });

    expect(result.ok).toBe(true);
    expect(policy.asked).toHaveLength(1); // 记住也不能跳过
    const used = log.byType('credential.used');
    expect(used).toHaveLength(1);
    expect(used[0]?.payload).toMatchObject({ toolName: 'read_secret', taskId: 't_secret' });
  });
});

describe('执行后验证 · 动作成功但结果不对', () => {
  it('verify 返回失败时，框架不把调用当成功', async () => {
    const log = new EventLog('s_verify');
    const clock = new FixedClock(T0);
    const policy = new TestPolicy('allow');
    const fw = new ToolFramework({ log, clock, policy });
    let rolledBack = false;
    fw.register({
      name: 'fake_write',
      description: '假写入（测试用）',
      parameters: { type: 'object', properties: {} },
      tier: 'normal',
      summarize: () => '假写入',
      execute: async () => ({
        ok: true,
        output: '写了',
        durationMs: 1,
        rollback: async () => {
          rolledBack = true;
        },
      }),
      verify: async () => ({ ok: false, note: '目标文件不存在' }),
    });

    const result = await fw.execute({
      toolName: 'fake_write',
      args: {},
      taskId: 't_verify',
    });

    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('执行后校验失败');
    expect(rolledBack).toBe(true);
    const results = log.byType('tool.result');
    expect(results[results.length - 1]?.payload).toMatchObject({
      toolName: 'fake_write',
      isError: true,
      verified: false,
      rolledBack: true,
    });
  });
});
