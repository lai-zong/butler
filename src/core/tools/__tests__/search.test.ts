import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { applyPatchTool } from '../builtin/file.js';
import { grepTool, globTool } from '../builtin/search.js';
import { webFetchTool } from '../builtin/web.js';
import type { ToolContext } from '../types.js';

const T0 = 1_760_000_000_000;

function setup(): {
  readonly fs: MemoryFileSystem;
  readonly ctx: ToolContext;
} {
  const fs = new MemoryFileSystem({ now: T0 });
  fs.seedFile('a.ts', 'const x = 1;\n// 花生过敏\nconst y = 2;\n');
  fs.seedFile('docs/b.md', '# 文档\n花生酱禁用\n');
  fs.seedFile('skip.txt', '花生\n');
  return {
    fs,
    ctx: { clock: { now: () => T0 }, taskId: 't' },
  };
}

describe('只读检索/编辑工具', () => {
  it('glob 按文件名模式找文件', async () => {
    const { fs, ctx } = setup();
    const result = await globTool(fs).execute({ pattern: '**/*.ts' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ files: ['a.ts'] });
  });

  it('grep 搜文件内容并给出行号', async () => {
    const { fs, ctx } = setup();
    const result = await grepTool(fs).execute(
      { query: '花生', glob: '**/*.md' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('docs/b.md:2');
  });

  it('apply_patch 只替换指定文本', async () => {
    const { fs, ctx } = setup();
    const result = await applyPatchTool(fs).execute(
      { path: 'a.ts', oldText: 'const x = 1;', newText: 'const x = 99;' },
      ctx,
    );
    expect(result.ok).toBe(true);
    await expect(fs.readText('a.ts')).resolves.toContain('const x = 99;');
    await expect(fs.readText('a.ts')).resolves.not.toContain('const x = 1;');
  });

  it('apply_patch 找不到旧文本时拒绝且不写', async () => {
    const { fs, ctx } = setup();
    const result = await applyPatchTool(fs).execute(
      { path: 'a.ts', oldText: '不存在', newText: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    await expect(fs.readText('a.ts')).resolves.toContain('const x = 1;');
  });

  it('web_fetch 拒绝本机地址', async () => {
    const { ctx } = setup();
    const result = await webFetchTool().execute({ url: 'http://127.0.0.1:3000/' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('私网');
  });
});
