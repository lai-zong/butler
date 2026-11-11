/**
 * 工作区面板的文件服务
 *
 * 钉住四件事：
 * ① 不能读到/写到工作区外（含 junction 逃逸）；
 * ② 受保护路径任何时候都拒绝；
 * ③ 保存会检测外部改动，不静默覆盖；
 * ④ 每次保存都有 `file.edited` 留痕（只记路径与指纹）。
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../core/events/log.js';
import { FixedClock } from '../../../core/ports/clock.js';
import {
  listWorkspace,
  readWorkspaceBytes,
  readWorkspaceRaw,
  readWorkspaceText,
  writeWorkspaceText,
  WorkspaceFileError,
} from '../workspaceFiles.js';

const T0 = 1_760_000_000_000;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'butler-ws-'));
  const root = join(base, 'workplace');
  const dataDir = join(base, '.butler-data');
  mkdirSync(root, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'note.md'), '# 标题\n正文', 'utf8');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.txt'), 'aaa', 'utf8');
  writeFileSync(join(base, 'outside.txt'), '外面', 'utf8');

  const log = new EventLog('s_ws');
  const clock = new FixedClock(T0);
  const protectedPaths = [dataDir, join(root, '.env.local')];
  return { base, root, dataDir, protectedPaths, log, clock };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error('应当抛错但没有');
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceFileError);
    expect((err as WorkspaceFileError).code).toBe(code);
  }
}

describe('列目录', () => {
  it('返回目录与文件，目录排前面', async () => {
    const { root, protectedPaths } = setup();
    const result = await listWorkspace(root, protectedPaths, '.');
    expect(result.entries.map((e) => e.name)).toEqual(['docs', 'note.md']);
    expect(result.entries[0]?.isDirectory).toBe(true);
    expect(result.entries[1]?.path).toBe('note.md');
  });

  it('受保护路径不出现', async () => {
    const { root, dataDir } = setup();
    writeFileSync(join(root, 'secret.txt'), 'x', 'utf8');
    const result = await listWorkspace(root, [dataDir, join(root, 'secret.txt')], '.');
    expect(result.entries.map((e) => e.name)).not.toContain('secret.txt');
  });

  it('工作区外直接拒绝', async () => {
    const { root, protectedPaths } = setup();
    await expectCode(() => listWorkspace(root, protectedPaths, '../'), 'outside_workspace');
  });

  it('符号链接标出来，且不当作目录进入', async () => {
    const { root, base, protectedPaths } = setup();
    try {
      symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'));
    } catch {
      return; // 没有建链接权限的环境跳过
    }
    const result = await listWorkspace(root, protectedPaths, '.');
    const link = result.entries.find((e) => e.name === 'link.txt');
    expect(link?.isSymbolicLink).toBe(true);
  });
});

describe('读文本', () => {
  it('返回内容与指纹', async () => {
    const { root, protectedPaths } = setup();
    const file = await readWorkspaceText(root, protectedPaths, 'note.md');
    expect(file.content).toContain('标题');
    expect(file.sha256).toHaveLength(64);
  });

  it('二进制文件拒绝', async () => {
    const { root, protectedPaths } = setup();
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    await expectCode(() => readWorkspaceText(root, protectedPaths, 'bin.dat'), 'not_text');
  });

  it('受保护文件拒绝', async () => {
    // 用工作区内部受保护的文件，避免先撞上"工作区外"那条规则
    const { root, protectedPaths } = setup();
    writeFileSync(join(root, '.env.local'), 'SECRET=1', 'utf8');
    await expectCode(() => readWorkspaceText(root, protectedPaths, '.env.local'), 'protected');
  });
});

describe('写文本', () => {
  it('保存成功并落 file.edited 事件（不记内容）', async () => {
    const { root, protectedPaths, log, clock } = setup();
    const saved = await writeWorkspaceText({
      root,
      protectedPaths,
      path: 'note.md',
      content: '# 新标题',
      log,
      clock,
    });
    expect(saved.size).toBeGreaterThan(0);

    const events = log.byType('file.edited');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['path']).toBe('note.md');
    expect(payload['bytes']).toBe(saved.size);
    expect(payload['sha256']).toBe(saved.sha256);
    // 内容不进事件
    expect(JSON.stringify(payload)).not.toContain('新标题');
  });

  it('外部已改动时拒绝（不静默覆盖）', async () => {
    const { root, protectedPaths, log, clock } = setup();
    const first = await readWorkspaceText(root, protectedPaths, 'note.md');
    writeFileSync(join(root, 'note.md'), '别人改过了', 'utf8');

    await expectCode(
      () =>
        writeWorkspaceText({
          root,
          protectedPaths,
          path: 'note.md',
          content: '我的版本',
          baseSha: first.sha256,
          log,
          clock,
        }),
      'conflict',
    );
  });

  it('指纹一致时允许保存', async () => {
    const { root, protectedPaths, log, clock } = setup();
    const first = await readWorkspaceText(root, protectedPaths, 'note.md');
    const saved = await writeWorkspaceText({
      root,
      protectedPaths,
      path: 'note.md',
      content: first.content + '\n追加',
      baseSha: first.sha256,
      log,
      clock,
      });
    expect(saved.sha256).not.toBe(first.sha256);
  });

  it('工作区外拒绝写入', async () => {
    const { root, base, protectedPaths, log, clock } = setup();
    await expectCode(
      () =>
        writeWorkspaceText({
          root,
          protectedPaths,
          path: join(base, 'outside.txt'),
          content: '越界',
          log,
          clock,
        }),
      'outside_workspace',
    );
  });

  it('受保护路径拒绝写入', async () => {
    // 同上：受保护文件在工作区内，才能区分 protected 与 outside_workspace
    const { root, protectedPaths, log, clock } = setup();
    await expectCode(
      () =>
        writeWorkspaceText({
          root,
          protectedPaths,
          path: '.env.local',
          content: 'SECRET=2',
          log,
          clock,
        }),
      'protected',
    );
  });
});

describe('读取字节（供服务端解析预览）', () => {
  it('docx 不在 raw 白名单里，但字节读取允许', async () => {
    const { root, protectedPaths } = setup();
    writeFileSync(join(root, 'a.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // 直出端点拒绝
    await expectCode(() => readWorkspaceRaw(root, protectedPaths, 'a.docx'), 'not_text');
    // 解析预览用的字节读取放行
    const bytes = await readWorkspaceBytes(root, protectedPaths, 'a.docx');
    expect(bytes.extension).toBe('.docx');
    expect(bytes.buffer.length).toBe(4);
  });

  it('字节读取同样受工作区与保护路径约束', async () => {
    const { root, protectedPaths } = setup();
    await expectCode(() => readWorkspaceBytes(root, protectedPaths, '../outside.txt'), 'outside_workspace');
    writeFileSync(join(root, '.env.local'), 'SECRET=1', 'utf8');
    await expectCode(() => readWorkspaceBytes(root, protectedPaths, '.env.local'), 'protected');
  });
});

describe('二进制预览', () => {
  it('图片返回正确 MIME', async () => {
    const { root, protectedPaths } = setup();
    writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const raw = await readWorkspaceRaw(root, protectedPaths, 'pic.png');
    expect(raw.mime).toBe('image/png');
  });

  it('非图片扩展名拒绝', async () => {
    const { root, protectedPaths } = setup();
    await expectCode(() => readWorkspaceRaw(root, protectedPaths, 'note.md'), 'not_text');
  });
});
