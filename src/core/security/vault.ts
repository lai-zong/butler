/**
 * 本地凭证保险库
 *
 * 设计边界（不夸大）：
 *   · 密文落盘；列表 API 只返回名称/时间，不返回值；
 *   · 解密只给内部使用（工具配置），不经过模型上下文；
 *   · 加密由 Windows DPAPI 负责，绑定当前 Windows 用户；
 *   · 同一台机器上的其他 Windows 用户不能直接解密；
 *   · 不把凭证写进事件流、记忆、导出文件。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CredentialMeta {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface CredentialCipher {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

interface StoredCredential extends CredentialMeta {
  readonly cipher: string;
}

interface VaultFile {
  readonly version: 1;
  readonly entries: readonly StoredCredential[];
}

const MAX_ENTRIES = 100;
const MAX_NAME = 80;
const MAX_SECRET = 16_384;

export class CredentialVault {
  private loaded = false;
  private entries: StoredCredential[] = [];

  constructor(
    private readonly file: string,
    private readonly cipher: CredentialCipher,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VaultFile>;
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(
            (e): e is StoredCredential =>
              typeof e === 'object' &&
              e !== null &&
              typeof (e as StoredCredential).id === 'string' &&
              typeof (e as StoredCredential).name === 'string' &&
              typeof (e as StoredCredential).cipher === 'string' &&
              typeof (e as StoredCredential).createdAt === 'number',
          )
        : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.entries = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: VaultFile = { version: 1, entries: this.entries };
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  async list(): Promise<readonly CredentialMeta[]> {
    await this.load();
    return this.entries.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  async put(nameRaw: string, secretRaw: string): Promise<CredentialMeta> {
    await this.load();
    const name = nameRaw.trim();
    const secret = secretRaw.trim();
    if (name.length === 0 || name.length > MAX_NAME) {
      throw new Error(`凭证名称必须为 1—${MAX_NAME} 个字符`);
    }
    if (secret.length === 0 || secret.length > MAX_SECRET) {
      throw new Error(`凭证内容必须为 1—${MAX_SECRET} 个字符`);
    }
    const cipher = await this.cipher.encrypt(secret);
    const existing = this.entries.find((e) => e.name === name);
    if (existing !== undefined) {
      this.entries = this.entries.map((e) =>
        e.id === existing.id ? { ...e, cipher, createdAt: this.now() } : e,
      );
    } else {
      if (this.entries.length >= MAX_ENTRIES) throw new Error(`最多保存 ${MAX_ENTRIES} 条凭证`);
      this.entries = [
        ...this.entries,
        { id: `cred_${randomUUID()}`, name, cipher, createdAt: this.now() },
      ];
    }
    await this.save();
    const meta = this.entries.find((e) => e.name === name);
    if (meta === undefined) throw new Error('凭证保存失败');
    return { id: meta.id, name: meta.name, createdAt: meta.createdAt };
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    await this.save();
    return true;
  }

  /** 内部使用：按 id 或名称取明文；绝不暴露给 HTTP GET。 */
  async resolve(idOrName: string): Promise<string | null> {
    await this.load();
    const entry = this.entries.find((e) => e.id === idOrName || e.name === idOrName);
    if (entry === undefined) return null;
    return this.cipher.decrypt(entry.cipher);
  }
}
