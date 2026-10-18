/**
 * 请求图片校验测试（E4 上传入口）
 *
 * ★ 重点不是"合法能过"，而是**非法一律整轮拒绝**：
 *   静默丢图会让用户以为发了图、模型却没看到。
 */
import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENTS } from '../attach.js';
import { normalizeRequestImages } from '../requestImages.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('normalizeRequestImages —— 合法输入', () => {
  it('没给 images → 空数组（不影响纯文本对话）', () => {
    expect(normalizeRequestImages(undefined)).toEqual({ ok: true, images: [] });
    expect(normalizeRequestImages(null)).toEqual({ ok: true, images: [] });
  });

  it('data URL 图片通过，并保留 url', () => {
    const r = normalizeRequestImages([{ url: PNG }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images[0]?.url).toBe(PNG);
  });

  it('http(s) 链接通过', () => {
    const r = normalizeRequestImages([{ url: 'https://example.com/a.png' }]);
    expect(r.ok).toBe(true);
  });

  it('detail 合法值被保留，非法值被丢弃（不报错）', () => {
    const okRes = normalizeRequestImages([{ url: PNG, detail: 'high' }]);
    expect(okRes.ok && okRes.images[0]?.detail).toBe('high');

    const badRes = normalizeRequestImages([{ url: PNG, detail: 'ultra' }]);
    expect(badRes.ok).toBe(true);
    if (badRes.ok) expect(badRes.images[0]?.detail).toBeUndefined();
  });
});

describe('★ normalizeRequestImages —— 非法输入必须整轮拒绝', () => {
  it('images 不是数组 → 拒绝', () => {
    const r = normalizeRequestImages('not-an-array');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('数组');
  });

  it('缺 url → 拒绝并指出第几张', () => {
    const r = normalizeRequestImages([{ url: PNG }, {}]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('第 2 张');
  });

  it('★ 非图片格式 → 拒绝（不给模型送它读不了的东西）', () => {
    const r = normalizeRequestImages([{ url: 'data:application/pdf;base64,AAAA' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('格式不支持');
  });

  it('★ 数量超限 → 拒绝', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ url: PNG }));
    const r = normalizeRequestImages(many);
    expect(r.ok).toBe(false);
  });

  it('★★ 体积超限 → 拒绝（按 base64 长度折算真实字节）', () => {
    // 构造一个远超单图上限的 data URL（不真的分配 32MB，用长度算）
    const huge = 'data:image/png;base64,' + 'A'.repeat(50 * 1024 * 1024);
    const r = normalizeRequestImages([{ url: huge }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
