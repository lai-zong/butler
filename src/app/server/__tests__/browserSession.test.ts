/**
 * 浏览器面板的可测部分
 *
 * CDP 本身需要真实浏览器，不在这里跑；这里钉住地址识别与可执行文件探测。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BrowserError, clampViewport, DEFAULT_VIEWPORT, findBrowserExecutable, normalizeAddress } from '../browserSession.js';

describe('地址栏识别', () => {
  it('带协议的按网址处理', () => {
    expect(normalizeAddress('https://example.com/a')).toEqual({ kind: 'url', url: 'https://example.com/a' });
    expect(normalizeAddress('about:blank').kind).toBe('url');
  });

  it('裸域名补 https', () => {
    expect(normalizeAddress('example.com')).toEqual({ kind: 'url', url: 'https://example.com' });
    expect(normalizeAddress('github.com/a/b')).toEqual({ kind: 'url', url: 'https://github.com/a/b' });
  });

  it('关键词走搜索引擎', () => {
    const r = normalizeAddress('今天天气');
    expect(r.kind).toBe('search');
    expect(r.url).toContain(encodeURIComponent('今天天气'));
  });

  it('可以用环境变量切换到百度', () => {
    process.env['BUTLER_SEARCH_ENGINE'] = 'baidu';
    try {
      expect(normalizeAddress('红烧肉').url.startsWith('https://www.baidu.com/s?wd=')).toBe(true);
    } finally {
      delete process.env['BUTLER_SEARCH_ENGINE'];
    }
  });

  it('空输入报错', () => {
    expect(() => normalizeAddress('   ')).toThrow(BrowserError);
  });
});

describe('浏览器可执行文件探测', () => {
  it('BUTLER_BROWSER_PATH 优先', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-exe-'));
    const fake = join(dir, 'my-chromium.exe');
    writeFileSync(fake, 'x');
    expect(findBrowserExecutable({ BUTLER_BROWSER_PATH: fake })).toBe(fake);
  });

  it('路径不存在时忽略，回退到系统浏览器', () => {
    const found = findBrowserExecutable({ BUTLER_BROWSER_PATH: 'C:\\nope\\nope.exe' });
    // 本机应能回退到 Edge；若没有则返回 null 也算正确
    expect(found === null || /msedge\.exe$|chrome\.exe$/i.test(found)).toBe(true);
  });
});

describe('远端视口尺寸', () => {
  it('正常尺寸原样返回（四舍五入）', () => {
    expect(clampViewport(900.4, 600.6)).toEqual({ width: 900, height: 601 });
  });

  it('夹到上下限，避免面板拖动时尺寸失控', () => {
    expect(clampViewport(10, 10)).toEqual({ width: 360, height: 240 });
    expect(clampViewport(99999, 99999)).toEqual({ width: 2400, height: 1600 });
  });

  it('非法值回落到默认视口', () => {
    expect(clampViewport(Number.NaN, Number.NaN)).toEqual(DEFAULT_VIEWPORT);
  });
});
