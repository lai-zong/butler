/**
 * 服务端页面读取 query 的小工具。
 *
 * Next 15 的 searchParams 既可能是 string，也可能是 string[]（重复参数）；
 * 只取第一个值，其它一律当没传——真正的合法性由 safeNextPath 在客户端再判一次。
 */

export function firstSearchParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return null;
}
