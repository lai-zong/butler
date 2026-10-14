/**
 * 命令执行工具测试
 *
 * ⚠️ 这个测试文件**不执行任何真实命令** —— 用 FakeExec 预设输出。
 *    理由有两条：
 *      ① 可重复：真实命令的输出随环境变化，测试会不稳
 *      ② 安全：测试不该有"误跑一条真命令"的可能
 *
 *    真实执行的验证放在验证脚本里（那里有明确的边界与清理）。
 */

import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import {
  DEFAULT_TIMEOUT_MS,
  ExecError,
  type ExecPort,
  type ExecRequest,
  type ExecResult,
} from '../../ports/exec.js';
import { fileTools } from '../builtin/file.js';
import { detectRisk, execTool } from '../builtin/exec.js';
import { ToolFramework } from '../framework.js';
import type { ActionTier, Authorization, PermissionPolicy } from '../types.js';

const T0 = 1_760_000_000_000;

/** 假执行器：记录请求，返回预设结果。 */
class FakeExec implements ExecPort {
  readonly supported = true;
  readonly calls: ExecRequest[] = [];

  constructor(
    private readonly responses: readonly Partial<ExecResult>[] = [],
    private readonly throwOn?: Error,
  ) {}

  async run(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    if (this.throwOn) throw this.throwOn;
    const preset = this.responses[this.calls.length - 1] ?? {};
    return {
      exitCode: preset.exitCode ?? 0,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      timedOut: preset.timedOut ?? false,
      truncated: preset.truncated ?? false,
      durationMs: preset.durationMs ?? 5,
    };
  }
}

/** 不支持执行的环境（浏览器）。 */
class UnsupportedExec implements ExecPort {
  readonly supported = false;
  async run(): Promise<ExecResult> {
    throw new ExecError('不支持', 'NOT_SUPPORTED');
  }
}

class AllowPolicy implements PermissionPolicy {
  readonly asked: { toolName: string; preview?: string }[] = [];
  constructor(
    private readonly answer: Authorization = 'allow',
    private readonly enabled: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk', 'dangerous'],
  ) {}
  isRemembered(): boolean {
    return false;
  }
  isTierEnabled(t: ActionTier): boolean {
    return this.enabled.includes(t);
  }
  async ask(req: { toolName: string; preview?: string }): Promise<Exclude<Authorization, 'blocked'>> {
    this.asked.push(req);
    return this.answer === 'blocked' ? 'deny' : this.answer;
  }
}

function setup(exec: ExecPort, answer: Authorization = 'allow') {
  const log = new EventLog('s_exec');
  const clock = new FixedClock(T0);
  const policy = new AllowPolicy(answer);
  const fw = new ToolFramework({ log, clock, policy });
  fw.registerAll(fileTools(new MemoryFileSystem({ now: T0 })));
  fw.register(execTool(exec, '/work'));
  return { log, clock, policy, fw, exec };
}

// ═══════════════════════════════════════════════════════════
// 分级与闸门
// ═══════════════════════════════════════════════════════════

describe('命令执行 · 分级为 highRisk', () => {
  it('工具声明自己是 highRisk', () => {
    const tool = execTool(new FakeExec(), '/work');
    expect(tool.tier).toBe('highRisk');
  });

  it('★ 每次执行都要用户确认', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: 'ok' }]));
    await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't1' });
    expect(policy.asked).toHaveLength(1);
  });

  it('★ 用户拒绝时不执行（exec 一次都没被调用）', async () => {
    const exec = new FakeExec();
    const { fw } = setup(exec, 'deny');
    await expect(
      fw.execute({ toolName: 'run_command', args: { command: 'rm', args: ['-rf', '/'] }, taskId: 't1' }),
    ).rejects.toThrow();
    expect(exec.calls).toHaveLength(0);
  });

  it('highRisk 仍需确认（不是禁用）—— 关掉 highRisk 不影响它被询问', async () => {
    const exec = new FakeExec([{ stdout: 'ok' }]);
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const policy = new AllowPolicy('allow', ['readOnly']);
    const fw = new ToolFramework({ log, clock, policy });
    fw.register(execTool(exec, '/work'));

    const r = await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't' });
    // highRisk 的语义是"每次确认"，不是"默认禁用"
    expect(r.ok).toBe(true);
    expect(policy.asked).toHaveLength(1);
  });

  it('★ dangerous 级别未开启时直接禁用（连问都不问）', async () => {
    const exec = new FakeExec();
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const policy = new AllowPolicy('allow', ['readOnly', 'normal', 'highRisk']);
    const fw = new ToolFramework({ log, clock, policy });
    const fs = new MemoryFileSystem({ now: T0 });
    fs.seedFile('a.txt', 'x');
    fw.registerAll(fileTools(fs));
    fw.register(execTool(exec, '/work'));

    await expect(
      fw.execute({ toolName: 'remove_path', args: { path: 'a.txt' }, taskId: 't' }),
    ).rejects.toThrow(/默认禁用/);
    expect(await fs.exists('a.txt')).toBe(true);
    expect(policy.asked).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 预览：把风险说出来
// ═══════════════════════════════════════════════════════════

describe('★ 只读预览 · 把风险差异体现出来', () => {
  it('只读命令标注"看起来是只读"', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: '' }]));
    await fw.execute({ toolName: 'run_command', args: { command: 'git', args: ['status'] }, taskId: 't' });
    const preview = policy.asked[0]?.preview ?? '';
    expect(preview).toContain('将执行：git status');
    expect(preview).toContain('工作目录：/work');
    expect(preview).toContain('看起来是只读命令');
  });

  it('★ 删除命令给出明确警告', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: '' }]));
    await fw.execute({
      toolName: 'run_command',
      args: { command: 'rm', args: ['-rf', 'build'] },
      taskId: 't',
    });
    const preview = policy.asked[0]?.preview ?? '';
    expect(preview).toContain('删除文件');
    expect(preview).toContain('递归强制删除，不可恢复');
  });

  it('强制推送给出警告', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: '' }]));
    await fw.execute({
      toolName: 'run_command',
      args: { command: 'git', args: ['push', '--force'] },
      taskId: 't',
    });
    expect(policy.asked[0]?.preview ?? '').toContain('重写远端历史');
  });

  it('网络请求给出警告', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: '' }]));
    await fw.execute({ toolName: 'run_command', args: { command: 'curl', args: ['http://x'] }, taskId: 't' });
    expect(policy.asked[0]?.preview ?? '').toContain('网络请求');
  });

  it('超时被限制在上限内', async () => {
    const { fw, policy } = setup(new FakeExec([{ stdout: '' }]));
    await fw.execute({
      toolName: 'run_command',
      args: { command: 'sleep', args: ['999'], timeoutMs: 999_999_999 },
      taskId: 't',
    });
    expect(policy.asked[0]?.preview ?? '').toContain('300000 ms');
  });
});

describe('detectRisk · 风险识别', () => {
  it('识别各类危险操作', () => {
    expect(detectRisk('rm', ['-rf', '/tmp'])).toContain('删除文件');
    expect(detectRisk('git', ['reset', '--hard'])).toContain('会丢弃未提交的改动');
    expect(detectRisk('pnpm', ['publish'])).toContain('发布到公共仓库');
    expect(detectRisk('chmod', ['777', 'x'])).toContain('修改权限');
    expect(detectRisk('shutdown', ['/s'])).toContain('影响系统运行');
  });

  it('普通命令不误报', () => {
    expect(detectRisk('git', ['status'])).toEqual([]);
    expect(detectRisk('node', ['--version'])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 执行行为
// ═══════════════════════════════════════════════════════════

describe('执行行为', () => {
  it('返回退出码与输出', async () => {
    const { fw } = setup(new FakeExec([{ exitCode: 0, stdout: '文件列表' }]));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('退出码：0');
    expect(r.output).toContain('文件列表');
  });

  it('★ 非零退出码是正常结果，如实返回（不是崩溃）', async () => {
    const { fw } = setup(new FakeExec([{ exitCode: 1, stderr: 'fatal: not a git repository' }]));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'git', args: ['status'] }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('退出码：1');
    expect(r.output).toContain('not a git repository');
  });

  it('★ 超时被明确标注（不允许"看起来成功"）', async () => {
    const { fw } = setup(new FakeExec([{ timedOut: true, stdout: '部分输出' }]));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'sleep', args: ['999'] }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('超时');
    expect(r.output).toContain('已被终止');
  });

  it('输出被截断时明确说明', async () => {
    const { fw } = setup(new FakeExec([{ stdout: 'x', truncated: true }]));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'cat', args: ['big'] }, taskId: 't' });
    expect(r.output).toContain('已截断');
  });

  it('无输出时明确说明', async () => {
    const { fw } = setup(new FakeExec([{ stdout: '', stderr: '' }]));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'true' }, taskId: 't' });
    expect(r.output).toContain('（无输出）');
  });

  it('参数错误时返回可读消息', async () => {
    const { fw } = setup(new FakeExec());
    const r = await fw.execute({ toolName: 'run_command', args: { command: '' }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('command 必须是非空字符串');
  });

  it('args 类型错误时返回可读消息', async () => {
    const { fw } = setup(new FakeExec());
    const r = await fw.execute({
      toolName: 'run_command',
      args: { command: 'ls', args: 'not-an-array' },
      taskId: 't',
    });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('必须是字符串数组');
  });

  it('cwd 省略时用默认工作目录', async () => {
    const exec = new FakeExec([{ stdout: '' }]);
    const { fw } = setup(exec);
    await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't' });
    expect(exec.calls[0]?.cwd).toBe('/work');
  });

  it('timeoutMs 省略时用默认值', async () => {
    const exec = new FakeExec([{ stdout: '' }]);
    const { fw } = setup(exec);
    await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't' });
    expect(exec.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('执行器抛错时转成可读结果', async () => {
    const { fw } = setup(new FakeExec([], new ExecError('无法启动进程', 'SPAWN_FAILED')));
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'nope' }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('无法执行');
  });

  it('★ 诚实降级：浏览器环境明确说"不支持"而不是假装能做', async () => {
    const { fw } = setup(new UnsupportedExec());
    const r = await fw.execute({ toolName: 'run_command', args: { command: 'ls' }, taskId: 't' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('不支持执行命令');
    expect(r.output).toContain('如实降级');
  });
});

// ═══════════════════════════════════════════════════════════
// 审计
// ═══════════════════════════════════════════════════════════

describe('命令执行的审计', () => {
  it('★ 命令与参数进审计（事后能追查"它到底跑了什么"）', async () => {
    const { fw } = setup(new FakeExec([{ stdout: 'ok' }]));
    await fw.execute({
      toolName: 'run_command',
      args: { command: 'git', args: ['log', '--oneline', '-5'] },
      taskId: 't1',
    });

    const audit = fw.allAudits()[0];
    expect(audit?.argsSummary).toContain('git');
    expect(audit?.argsSummary).toContain('--oneline');
    expect(audit?.tier).toBe('highRisk');
    expect(audit?.taskId).toBe('t1');
  });

  it('★ 被拒绝的命令不执行但留审计', async () => {
    const exec = new FakeExec();
    const { fw } = setup(exec, 'deny');
    await expect(
      fw.execute({ toolName: 'run_command', args: { command: 'rm', args: ['-rf', '/'] }, taskId: 't' }),
    ).rejects.toThrow();
    expect(exec.calls).toHaveLength(0);
    expect(fw.allAudits()[0]?.outcome).toBe('denied');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 无 shell 注入
// ═══════════════════════════════════════════════════════════

describe('★ 不接受 shell 字符串（防注入）', () => {
  it('参数里的 shell 元字符只是普通字符串', async () => {
    const exec = new FakeExec([{ stdout: '' }]);
    const { fw } = setup(exec);

    await fw.execute({
      toolName: 'run_command',
      args: { command: 'echo', args: ['a; rm -rf /', '&&', 'whoami', '|', 'cat /etc/passwd'] },
      taskId: 't',
    });

    // ★ 关键断言：这些字符作为**独立参数**传下去，没有被拼接成 shell 命令
    expect(exec.calls[0]?.args).toEqual(['a; rm -rf /', '&&', 'whoami', '|', 'cat /etc/passwd']);
    expect(exec.calls[0]?.command).toBe('echo');
  });

  it('命令名里的路径遍历不会被解释', async () => {
    const exec = new FakeExec();
    const { fw } = setup(exec);
    await fw.execute({ toolName: 'run_command', args: { command: '../../bin/sh' }, taskId: 't' });
    // 原样传给执行器 —— 拦截不在这里，而在分级 + 用户确认
    expect(exec.calls[0]?.command).toBe('../../bin/sh');
  });
});
