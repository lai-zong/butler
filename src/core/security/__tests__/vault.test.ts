import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CredentialVault,
  type CredentialCipher,
} from '../vault.js';

const dirs: string[] = [];

async function vault(): Promise<CredentialVault> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-vault-'));
  dirs.push(dir);
  const cipher: CredentialCipher = {
    encrypt: (s) => Promise.resolve(Buffer.from(s).toString('base64')),
    decrypt: (c) => Promise.resolve(Buffer.from(c, 'base64').toString('utf8')),
  };
  return new CredentialVault(join(dir, 'credentials.json'), cipher, () => 1_760_000_000_000);
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('CredentialVault', () => {
  it('保存后列表不含明文，解析可取回', async () => {
    const v = await vault();
    const meta = await v.put('github_token', 'ghp_secret_123');
    expect(meta.name).toBe('github_token');
    const list = await v.list();
    expect(list[0]?.id).toBe(meta.id);
    expect(JSON.stringify(list)).not.toContain('ghp_secret_123');
    expect(await v.resolve(meta.id)).toBe('ghp_secret_123');
    expect(await v.resolve('github_token')).toBe('ghp_secret_123');
  });

  it('落盘文件没有明文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-vault-'));
    dirs.push(dir);
    const cipher: CredentialCipher = {
      encrypt: (s) => Promise.resolve(`enc:${Buffer.from(s).toString('base64')}`),
      decrypt: (c) => Promise.resolve(Buffer.from(c.replace(/^enc:/, ''), 'base64').toString('utf8')),
    };
    const file = join(dir, 'credentials.json');
    const v = new CredentialVault(file, cipher, () => 1);
    await v.put('api', 'super-secret-value');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).toContain('enc:');
  });

  it('同名更新不产生重复条目', async () => {
    const v = await vault();
    await v.put('a', '1');
    await v.put('a', '2');
    const list = await v.list();
    expect(list).toHaveLength(1);
    expect(await v.resolve('a')).toBe('2');
  });

  it('删除后无法再解析', async () => {
    const v = await vault();
    const meta = await v.put('a', '1');
    expect(await v.remove(meta.id)).toBe(true);
    expect(await v.remove(meta.id)).toBe(false);
    expect(await v.resolve(meta.id)).toBeNull();
  });
});
