/**
 * 会话级工具作用域的验收（核心）
 *
 * ★ 覆盖修订后的要求：
 *   ① 两个并发 session 不同 workspace/permission，工具根目录/权限不串；
 *   ② read-only 只读；写/删/命令都不可用；
 *   ③ workspace 只读 + 普通写，工作区外/受保护路径拒绝；highRisk 不开放；
 *      命令工具不注册；junction/symlink 逃逸用 realpath 拒绝；
 *   ④ full 可读工作区外文件，但 .butler-data/.env.local/config 始终拒绝；
 *      highRisk 无确认通道时拒绝；
 *   ⑤ 作用域是真实的 NodeFileSystem/NodeExec，不是只改策略对象的假实现。
 *
 * ⚠️ 所有目录都是临时目录；测试结束删除，不碰真实 .butler-data。
 */

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '@/core/events/log.js';
import type { ApprovalAsker } from '@/core/tools/approval.js';
import { ToolFramework } from '@/core/tools/framework.js';
import type { ToolSpec } from '@/core/tools/types.js';
import { createChatToolScope } from '../chatToolScope.js';
import { SessionPermissionPolicy } from '../sessionPermission.js';

const clock = { now: () => Date.now() };
const allowAll: ApprovalAsker = { request: async () => true };

let base = '';
let dataDir = '';
let appRoot = '';
let configDir = '';
let wsA = '';
let wsB = '';
let outsideDir = '';
let log: EventLog;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'butler-scope-'));
  dataDir = join(base, 'data');
  appRoot = join(base, 'app');
  configDir = join(appRoot, 'config');
  wsA = join(base, 'workspace-a');
  wsB = join(base, 'workspace-b');
  outsideDir = join(base, 'outside');
  await mkdir(dataDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(dataDir, 'events.jsonl'), '{"secret":true}', 'utf8');
  await writeFile(join(appRoot, '.env.local'), 'DEEPSEEK_API_KEY=sk-secret', 'utf8');
  await writeFile(join(configDir, 'AGENTS.md'), '# 全局规则\n不要改写我。', 'utf8');
  await writeFile(join(outsideDir, 'outside-secret.txt'), '工作区外的秘密', 'utf8');
  log = new EventLog('s_scope_test');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function scopeFor(
  workspace: string,
  permission: 'read-only' | 'workspace' | 'full',
  options: { readonly baseTools?: ToolFramework; readonly allowedPaths?: readonly string[] } = {},
) {
  return await createChatToolScope({
    log,
    clock,
    workspace,
    permission,
    dataDir,
    appRoot,
    documentSearch: { search: async () => [] },
    ...(options.baseTools !== undefined ? { baseTools: options.baseTools } : {}),
    ...(options.allowedPaths !== undefined ? { allowedPaths: options.allowedPaths } : {}),
  });
}

function execute(
  scope: Awaited<ReturnType<typeof createChatToolScope>>,
  toolName: string,
  args: unknown,
  asker: ApprovalAsker = allowAll,
) {
  return scope.tools.execute({
    toolName,
    args,
    taskId: 'task-1',
    task: '测试',
    asker,
  });
}

/** Windows 用 junction，其它平台用目录 symlink；无权限时返回 false。 */
async function makeDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('① 并发会话：工作区/权限不串', () => {
  it('两个不同 workspace 的会话各自读写自己的根目录', async () => {
    const [a, b] = await Promise.all([
      scopeFor(wsA, 'workspace'),
      scopeFor(wsB, 'workspace'),
    ]);
    expect(a.workspace).toBe(await realpath(wsA));
    expect(b.workspace).toBe(await realpath(wsB));
    expect(a.workspace).not.toBe(b.workspace);

    await Promise.all([
      execute(a, 'write_file', { path: 'only-a.txt', content: 'A 的内容' }),
      execute(b, 'write_file', { path: 'only-b.txt', content: 'B 的内容' }),
    ]);

    expect(await readFile(join(wsA, 'only-a.txt'), 'utf8')).toBe('A 的内容');
    expect(await readFile(join(wsB, 'only-b.txt'), 'utf8')).toBe('B 的内容');

    // 各自只能看到自己的文件；相对路径不会落到另一个会话的根目录
    const missing = await execute(a, 'read_file', { path: 'only-b.txt' });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('路径不存在');
    const own = await execute(a, 'read_file', { path: 'only-a.txt' });
    expect(own.ok).toBe(true);
    expect(own.output).toContain('A 的内容');
  });

  it('并发会话权限不同：A 可写、B 只读，互不影响', async () => {
    const [a, b] = await Promise.all([
      scopeFor(wsA, 'workspace'),
      scopeFor(wsB, 'read-only'),
    ]);
    await execute(a, 'write_file', { path: 'a.txt', content: 'A' });
    await expect(
      execute(b, 'write_file', { path: 'b.txt', content: 'B' }),
    ).rejects.toThrow(/只读|权限/);
    expect(a.policy.isTierEnabled('normal')).toBe(true);
    expect(b.policy.isTierEnabled('normal')).toBe(false);
  });
});

describe('② read-only：写 / 删 / 命令都不可用', () => {
  it('读可用；写、删、run_command 被拒', async () => {
    await writeFile(join(wsA, 'keep.txt'), 'keep', 'utf8');
    const scope = await scopeFor(wsA, 'read-only');
    const canRead = await execute(scope, 'read_file', { path: 'keep.txt' });
    expect(canRead.ok).toBe(true);

    await expect(
      execute(scope, 'write_file', { path: 'new.txt', content: 'x' }),
    ).rejects.toThrow(/只读/);
    await expect(
      execute(scope, 'file_op', { action: 'remove', path: 'keep.txt' }),
    ).rejects.toThrow(/只读/);
    await expect(
      execute(scope, 'run_command', { command: 'node', args: ['--version'] }),
    ).rejects.toThrow(/未知工具/);
  });

  it('读取也限制在本对话工作区内', async () => {
    const scope = await scopeFor(wsA, 'read-only');
    await expect(
      execute(scope, 'read_file', { path: join(outsideDir, 'outside-secret.txt') }),
    ).rejects.toThrow(/工作区权限拒绝/);
  });
});

describe('③ workspace：普通读写成功，工作区外/受保护路径拒绝', () => {
  it('工作区内写成功（真实的 NodeFileSystem）', async () => {
    const scope = await scopeFor(wsA, 'workspace');
    const result = await execute(scope, 'write_file', {
      path: 'reports/a.md',
      content: '# 报告',
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(wsA, 'reports', 'a.md'), 'utf8')).toBe('# 报告');
  });

  it('写工作区外被拒', async () => {
    const scope = await scopeFor(wsA, 'workspace');
    await expect(
      execute(scope, 'write_file', {
        path: join(wsB, 'escape.txt'),
        content: 'x',
      }),
    ).rejects.toThrow(/工作区权限拒绝/);
  });

  it('读工作区外被拒（workspace 档位连读取也限制）', async () => {
    const scope = await scopeFor(wsA, 'workspace');
    await expect(
      execute(scope, 'read_file', { path: join(wsB, 'secret.txt') }),
    ).rejects.toThrow(/工作区权限拒绝/);
  });

  it('highRisk（file_op move）在 workspace 档不开放', async () => {
    await writeFile(join(wsA, 'a.txt'), 'a', 'utf8');
    const scope = await scopeFor(wsA, 'workspace');
    await expect(
      execute(scope, 'file_op', { action: 'move', from: 'a.txt', to: 'b.txt' }),
    ).rejects.toThrow(/未开启该档位|权限模式 workspace/);
  });

  it('不注册 run_command；也不会从全局工具列表复制进来', async () => {
    const baseTools = new ToolFramework({
      log,
      clock,
      policy: new SessionPermissionPolicy('read-only'),
    });
    const fakeExec: ToolSpec = {
      name: 'run_command',
      description: '不该被复制',
      parameters: { type: 'object', properties: {} },
      tier: 'highRisk',
      summarize: () => 'exec',
      execute: async () => ({ ok: true, output: '不该执行', durationMs: 0 }),
    };
    baseTools.register(fakeExec);

    const scope = await scopeFor(wsA, 'workspace', { baseTools });
    expect(scope.tools.get('run_command')).toBeUndefined();
    await expect(
      execute(scope, 'run_command', { command: 'node', args: ['--version'] }),
    ).rejects.toThrow(/未知工具/);
  });

  it('受保护路径即使在工作区内也拒绝（DATA_DIR / config）', async () => {
    const scope = await scopeFor(appRoot, 'workspace');
    await expect(
      execute(scope, 'read_file', { path: join(dataDir, 'events.jsonl') }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'write_file', { path: 'config/AGENTS.md', content: '被篡改' }),
    ).rejects.toThrow(/受保护/);
  });

  it('无确认通道时普通写按会话档位授权；有 asker 时逐次确认优先', async () => {
    const scope = await scopeFor(wsA, 'workspace');
    // 不传 asker：policy.ask(normal) = allow（显式选择 workspace 即授权普通写）
    const direct = await scope.tools.execute({
      toolName: 'write_file',
      args: { path: 'x.txt', content: 'x' },
      taskId: 'task-1',
    });
    expect(direct.ok).toBe(true);
    expect(await readFile(join(wsA, 'x.txt'), 'utf8')).toBe('x');

    // 有确认通道且用户拒绝：仍然拒绝（Web 的 asker 优先）
    await expect(
      execute(scope, 'write_file', { path: 'y.txt', content: 'y' }, {
        request: async () => false,
      }),
    ).rejects.toThrow(/用户拒绝/);
  });

  it('junction/symlink 指向工作区外：读写都被 realpath 拒绝', async () => {
    const link = join(wsA, 'link-out');
    const created = await makeDirectoryLink(outsideDir, link);
    // 某些受限环境不允许创建 junction/symlink；此时跳过该断言（Windows dev 下会执行）
    if (!created) return;

    const scope = await scopeFor(wsA, 'workspace');
    await expect(
      execute(scope, 'read_file', { path: 'link-out/outside-secret.txt' }),
    ).rejects.toThrow(/工作区权限拒绝/);
    await expect(
      execute(scope, 'write_file', { path: 'link-out/new.txt', content: 'escape' }),
    ).rejects.toThrow(/工作区权限拒绝/);
    // 工作区内不存在被写出去的文件
    await expect(readFile(join(outsideDir, 'new.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('④ full：工作区外可用，但受保护路径/高风险确认仍严格', () => {
  it('可以读工作区外的普通文件', async () => {
    const scope = await scopeFor(wsA, 'full');
    const result = await execute(scope, 'read_file', {
      path: join(outsideDir, 'outside-secret.txt'),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('工作区外的秘密');
  });

  it('不能读 DATA_DIR / .env.local / 工作区自己的 .env.local / config', async () => {
    await writeFile(join(wsA, '.env.local'), 'LOCAL_KEY=secret', 'utf8');
    const scope = await scopeFor(wsA, 'full');

    await expect(
      execute(scope, 'read_file', { path: join(dataDir, 'events.jsonl') }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'read_file', { path: join(appRoot, '.env.local') }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'read_file', { path: join(wsA, '.env.local') }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'read_file', { path: join(configDir, 'AGENTS.md') }),
    ).rejects.toThrow(/受保护/);
  });

  it('不能写/移动进受保护目录（DATA_DIR / config）', async () => {
    await writeFile(join(wsA, 'move-me.txt'), 'x', 'utf8');
    const scope = await scopeFor(wsA, 'full');
    await expect(
      execute(scope, 'write_file', {
        path: join(configDir, 'AGENTS.md'),
        content: '被篡改',
      }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'file_op', {
        action: 'move',
        from: 'move-me.txt',
        to: join(dataDir, 'stolen.txt'),
      }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'file_op', {
        action: 'move',
        from: 'move-me.txt',
        to: join(configDir, 'AGENTS.md'),
      }),
    ).rejects.toThrow(/受保护/);
  });

  it('highRisk 没有确认通道时拒绝（不静默移动）', async () => {
    await writeFile(join(wsA, 'move-me.txt'), 'x', 'utf8');
    const scope = await scopeFor(wsA, 'full');
    await expect(
      scope.tools.execute({
        toolName: 'file_op',
        args: { action: 'move', from: 'move-me.txt', to: 'moved.txt' },
        taskId: 'task-1',
      }),
    ).rejects.toThrow(/用户拒绝/);
  });

  it('危险档位在 full 下仍被拒绝', async () => {
    const scope = await scopeFor(wsA, 'full');
    // file_op remove 是 dangerous：ToolFramework 的硬底线，不随 full 放开
    await expect(
      execute(scope, 'file_op', { action: 'remove', path: 'anything.txt' }),
    ).rejects.toThrow(/危险|禁用|档位/);
  });

  it('config 的 junction 仍被 realpath 识别为受保护', async () => {
    const link = join(wsA, 'link-config');
    const created = await makeDirectoryLink(configDir, link);
    if (!created) return;
    const scope = await scopeFor(wsA, 'full');
    await expect(
      execute(scope, 'read_file', { path: 'link-config/AGENTS.md' }),
    ).rejects.toThrow(/受保护/);
    await expect(
      execute(scope, 'write_file', { path: 'link-config/AGENTS.md', content: 'x' }),
    ).rejects.toThrow(/受保护/);
  });
});

describe('⑤ 作用域组装细节', () => {
  it('复制全局非文件工具（如桌面/MCP），但文件工具使用本会话的 fs', async () => {
    const baseTools = new ToolFramework({
      log,
      clock,
      policy: new SessionPermissionPolicy('read-only'),
    });
    const fake: ToolSpec = {
      name: 'desktop_ping',
      description: 'fake',
      parameters: { type: 'object', properties: {} },
      tier: 'readOnly',
      summarize: () => 'ping',
      execute: async () => ({ ok: true, output: 'pong', durationMs: 0 }),
    };
    baseTools.register(fake);
    const globalRead: ToolSpec = {
      ...fake,
      name: 'read_file',
      execute: async () => ({ ok: true, output: '不该被使用', durationMs: 0 }),
    };
    baseTools.register(globalRead, { overwrite: true });

    await writeFile(join(wsA, 'real.txt'), '本会话文件', 'utf8');
    const scope = await scopeFor(wsA, 'workspace', { baseTools });
    expect(scope.tools.get('desktop_ping')).toBeDefined();
    const result = await execute(scope, 'read_file', { path: 'real.txt' });
    expect(result.output).toContain('本会话文件');
    expect(result.output).not.toContain('不该被使用');
    // 策略是会话自己的，不是 baseTools 的
    expect(scope.tools.list().length).toBeGreaterThan(3);
  });

  it('工作区在作用域构造时再次校验（删除后拒绝）', async () => {
    await rm(wsA, { recursive: true, force: true });
    await expect(scopeFor(wsA, 'workspace')).rejects.toThrow(/不存在/);
  });

  it('document_search 已注册；run_command 不注册；protectedPaths 含 config', async () => {
    const scope = await scopeFor(wsA, 'read-only');
    expect(scope.tools.get('document_search')).toBeDefined();
    expect(scope.tools.get('read_file')).toBeDefined();
    expect(scope.tools.get('run_command')).toBeUndefined();
    expect(scope.protectedPaths).toContain(configDir);
  });
});

describe('⑥ 外部文件授权：只放行显式路径，受保护路径仍拒绝', () => {
  it('授权的文件可读写，未授权/受保护路径仍拒绝', async () => {
    const outside = join(outsideDir, 'outside-secret.txt');
    const scope = await scopeFor(wsA, 'workspace', { allowedPaths: [outside] });

    const read = await execute(scope, 'read_file', { path: outside });
    expect(read.ok).toBe(true);
    expect(read.output).toContain('工作区外的秘密');

    const write = await execute(scope, 'write_file', {
      path: outside,
      content: '由 AI 写入',
    });
    expect(write.ok).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('由 AI 写入');

    await expect(
      execute(scope, 'read_file', { path: join(outsideDir, 'not-granted.txt') }),
    ).rejects.toThrow(/工作区权限拒绝/);
  });

  it('授权指向受保护路径也不放行', async () => {
    const secret = join(dataDir, 'events.jsonl');
    await writeFile(secret, '{}', 'utf8');
    const scope = await scopeFor(wsA, 'workspace', { allowedPaths: [secret] });
    await expect(execute(scope, 'read_file', { path: secret })).rejects.toThrow(/受保护路径/);
  });
});

describe('⑦ 浏览器只读工具：已注册，浏览器未启动时给出可读错误', () => {
  it('browser_read / browser_tabs / browser_selection 都在作用域里', async () => {
    const scope = await scopeFor(wsA, 'workspace');
    for (const name of ['browser_read', 'browser_tabs', 'browser_selection']) {
      expect(scope.tools.get(name)).toBeDefined();
    }
    const result = await execute(scope, 'browser_read', {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain('浏览器还没启动');
  });

  it('read-only 档也可用（它们本身是只读的）', async () => {
    const scope = await scopeFor(wsA, 'read-only');
    const result = await execute(scope, 'browser_tabs', {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain('浏览器还没启动');
  });
});
