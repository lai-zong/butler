/**
 * 请求里的图片校验（E4 上传入口的第一道关）
 *
 * ★ 为什么独立成一个模块而不是写在路由文件里：
 *   ① Next 的 `route.ts` **只允许导出规定的几个符号**，
 *      导出一个普通函数会让类型检查直接报错（`OmitWithTag` 约束）。
 *   ② 放在 core 里可以**单独单测**，不必起服务。
 *
 * ⚠️ 三类输入都要挡：格式不对、体积超限、数量超限。
 *    而且必须**整轮拒绝**，不能静默丢图 ——
 *    用户以为发了图、模型却没看到，比直接报错糟得多。
 */

import { checkLimits } from './attach.js';

/** 允许的图片前缀（与 `attach.ts` 的 `VISION_MIMES` 对应） */
export const ALLOWED_IMAGE_PREFIXES: readonly string[] = [
  'data:image/png',
  'data:image/jpeg',
  'data:image/gif',
  'data:image/webp',
];

export type ImageDetail = 'low' | 'high' | 'original' | 'auto';

export interface NormalizedImage {
  readonly url: string;
  readonly detail?: ImageDetail;
}

export type NormalizeResult =
  | { readonly ok: true; readonly images: readonly NormalizedImage[] }
  | { readonly ok: false; readonly error: string };

/**
 * 校验并归一化请求里的图片。
 *
 * @param raw 来自请求体的原始数组（形状未知，必须逐项校验）
 */
export function normalizeRequestImages(raw: unknown): NormalizeResult {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'images 必须是数组' };

  const images: NormalizedImage[] = [];
  const sizes: { sizeBytes: number }[] = [];

  for (const [i, item] of raw.entries()) {
    const rec = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const url = typeof rec['url'] === 'string' ? rec['url'] : '';
    if (url.length === 0) return { ok: false, error: `第 ${i + 1} 张图片缺少 url` };

    const isHttp = url.startsWith('http://') || url.startsWith('https://');
    const isData = ALLOWED_IMAGE_PREFIXES.some((p) => url.startsWith(p));
    if (!isHttp && !isData) {
      return {
        ok: false,
        error:
          `第 ${i + 1} 张图片格式不支持：只接受 PNG / JPEG / GIF / WebP（data URL）或 http(s) 链接`,
      };
    }

    const d = rec['detail'];
    const detail: ImageDetail | undefined =
      d === 'low' || d === 'high' || d === 'original' || d === 'auto' ? d : undefined;

    images.push({ url, ...(detail !== undefined ? { detail } : {}) });
    // data URL 的真实字节数约为 base64 长度 × 3/4
    sizes.push({ sizeBytes: isData ? Math.floor((url.length * 3) / 4) : 0 });
  }

  const limits = checkLimits(sizes);
  if (!limits.ok) return { ok: false, error: limits.reason ?? '附件超出限制' };

  return { ok: true, images };
}
