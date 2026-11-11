/**
 * 模型探测地址准入 / 符号链接标记
 *
 * 两条都是实测过的边界：
 *   · discover 指向任意地址时，服务端会真的发请求（等于端口扫描器 + 密钥外发）；
 *   · `listDir` 用 stat 会把 junction 当成普通目录，遍历工具会跟着跑出工作区。
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverAllowedHostsFromEnv, discoverHostAllowed } from '../discoverGuard.js';
import { NodeFileSystem } from '../../../adapters/fs/node.js';

describe('discover 地址准入', () => {
  const preset = 'https://api.deepseek.com/v1';

  it('与预设同源放行', () => {
    expect(discoverHostAllowed({ baseUrl: preset, presetBaseUrl: preset })).toBe(true);
  });

  it('本机回环放行（本地 Ollama / 兼容层）', () => {
    expect(discoverHostAllowed({ baseUrl: 'http://127.0.0.1:11434/v1', presetBaseUrl: preset })).toBe(true);
    expect(discoverHostAllowed({ baseUrl: 'http://localhost:8080/v1', presetBaseUrl: preset })).toBe(true);
  });

  it('其它公网地址默认拒绝', () => {
    expect(discoverHostAllowed({ baseUrl: 'https://evil.example.com/v1', presetBaseUrl: preset })).toBe(false);
  });

  it('显式白名单可放行自定义网关', () => {
    expect(
      discoverHostAllowed({
        baseUrl: 'https://gateway.example.com/v1',
        presetBaseUrl: preset,
        allowedHosts: ['gateway.example.com'],
      }),
    ).toBe(true);
  });

  it('非 http(s) / 非法地址拒绝', () => {
    expect(discoverHostAllowed({ baseUrl: 'file:///etc/passwd', presetBaseUrl: preset })).toBe(false);
    expect(discoverHostAllowed({ baseUrl: '不是地址', presetBaseUrl: preset })).toBe(false);
  });

  it('环境变量解析', () => {
    expect(discoverAllowedHostsFromEnv({ MODEL_DISCOVER_ALLOWED_HOSTS: 'a.com, b.com' } as never)).toEqual([
      'a.com',
      'b.com',
    ]);
    expect(discoverAllowedHostsFromEnv({} as never)).toEqual([]);
  });
});

describe('符号链接标记', () => {
  it('junction 被标记为 isSymbolicLink，且不当作目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'butler-link-'));
    const root = join(base, 'ws');
    const outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'x', 'utf8');

    const link = join(root, 'link');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 没有权限建链接时跳过（CI 容器常见）
      return;
    }

    const fsPort = new NodeFileSystem({ root });
    return fsPort.listDir('.').then((entries) => {
      const entry = entries.find((e) => e.name === 'link');
      expect(entry).toBeDefined();
      expect(entry?.isSymbolicLink).toBe(true);
      expect(entry?.isDirectory).toBe(false);
    });
  });
});
