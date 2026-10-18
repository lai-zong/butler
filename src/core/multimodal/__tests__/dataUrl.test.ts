/**
 * 附件分类与领域路由（E1）
 *
 * ★ 这里测的是**"路由真的生效了"**：
 *   原实现把 `kind` 写死 `'image'`、`scope` 写死 `global_shared`，
 *   于是方案 §5.3 的「收据 → 健康领域」**永远不生效**。
 */
import { describe, expect, it } from 'vitest';

import { candidateScopeFor, classifyAttachment, routeAttachment } from '../attach.js';
import {
  classifyInputFromDataUrl,
  headBytesOf,
  parseDataUrl,
  sizeOfBase64,
} from '../dataUrl.js';

/** 1×1 PNG 的 base64（含真实 PNG 魔数）*/
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

describe('★ data URL 还原', () => {
  it('解析出 mime 与 base64', () => {
    const p = parseDataUrl(PNG_URL);
    expect(p?.mime).toBe('image/png');
    expect(p?.base64).toHaveLength(PNG_B64.length);
  });

  it('非 data URL 返回 null（不猜）', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
    expect(parseDataUrl('data:image/png,notbase64')).toBeNull();
  });

  it('★ 只解码前几个字节就能拿到 PNG 魔数（不整块解码）', () => {
    const head = headBytesOf(PNG_B64);
    expect(Array.from(head.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('字节数估算（含 padding 修正）', () => {
    /**
     * ⚠️ 这里**不写死一个我猜的数字** —— 之前写 68 是错的（真实 70）。
     *    改为与 Node 的权威解码长度对齐，再用三个固定小样例钉住 padding 规则。
     */
    expect(sizeOfBase64(PNG_B64)).toBe(Buffer.from(PNG_B64, 'base64').length);
    expect(sizeOfBase64('AAAA')).toBe(3);
    expect(sizeOfBase64('AAA=')).toBe(2);
    expect(sizeOfBase64('AA==')).toBe(1);
    expect(sizeOfBase64('')).toBe(0);
  });

  it('★★ 生成的分类入参能真的识别出 PNG', () => {
    const input = classifyInputFromDataUrl(PNG_URL, '附件1');
    expect(input).not.toBeNull();
    const c = classifyAttachment(input!);
    // 有魔数 → 按内容识别，mime 不是 null
    expect(c.detectedMime).toBe('image/png');
    expect(c.kind).toBe('image');
  });
});

describe('★★ 领域路由（§5.3 的映射）', () => {
  it('★★ 收据 → 健康领域（这是原来永远走不到的分支）', () => {
    const route = routeAttachment({ kind: 'receipt', needsUserConfirmation: false });
    expect(route.domain).toBe('health');
    expect(candidateScopeFor(route)).toEqual({ memClass: 'domain', domain: 'health' });
  });

  it('代码 → 代码领域；表格/文档 → 办公领域', () => {
    expect(routeAttachment({ kind: 'code', needsUserConfirmation: false }).domain).toBe('code');
    expect(routeAttachment({ kind: 'spreadsheet', needsUserConfirmation: false }).domain).toBe('work');
    expect(routeAttachment({ kind: 'document', needsUserConfirmation: false }).domain).toBe('work');
  });

  it('★★ 用途不确定 → **不猜领域**，且给出反问', () => {
    const route = routeAttachment({ kind: 'image', needsUserConfirmation: false });
    expect(route.domain).toBeNull();
    expect(route.question).toBeTruthy();
    // 候选只能落全局共享（待用户确认后再归类）
    expect(candidateScopeFor(route)).toEqual({ memClass: 'global_shared' });
  });

  it('★ 语音（butler）→ 全局共享，不是某个领域', () => {
    const route = routeAttachment({ kind: 'audio', needsUserConfirmation: false });
    expect(route.domain).toBe('butler');
    expect(candidateScopeFor(route)).toEqual({ memClass: 'global_shared' });
  });

  it('★★ 分类不确定时路由也必须返回 null（不硬派领域）', () => {
    const route = routeAttachment({ kind: 'receipt', needsUserConfirmation: true });
    expect(route.domain).toBeNull();
    expect(route.question).toContain('收据账单');
  });
});
