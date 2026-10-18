/**
 * 从 data URL 还原分类所需的信息。
 *
 * ★ 为什么需要它：
 *   `classifyAttachment` 要 `filename` / `declaredMime` / `sizeBytes` / `headBytes`，
 *   而聊天链路里拿到的是 `data:image/png;base64,...` ——
 *   不还原这几项，就只能**硬编码 `kind:'image'`**（那正是原实现的捷径：
 *   于是"收据 → 健康领域"的路由永远不生效）。
 *
 * ⚠️ `headBytes` 不是可有可无：`classifyAttachment` **优先按内容识别**，
 *    有魔数才能识别出 PNG/JPEG/PDF；没有就只能退回文件名（而聊天里往往没有文件名）。
 */

/** 解析 data URL；不是合法 data URL 时返回 null */
export function parseDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { mime: m[1] ?? '', base64: m[2] ?? '' };
}

/** 取前 n 个字节（用于魔数识别）*/
export function headBytesOf(base64: string, n = 16): Uint8Array {
  /**
   * ⚠️ 只解码前若干字符：base64 每 4 字符 = 3 字节，
   *    取 `ceil(n/3)*4` 个字符就够 n 字节。
   *    整图可能有几十 MB，**不能整块解码**。
   */
  const take = Math.ceil(n / 3) * 4;
  const slice = base64.slice(0, take);
  try {
    const buf = Buffer.from(slice, 'base64');
    return new Uint8Array(buf.subarray(0, n));
  } catch {
    return new Uint8Array(0);
  }
}

/** 估算原始字节数（base64 有 4/3 膨胀）*/
export function sizeOfBase64(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/** 从 data URL 生成 `classifyAttachment` 的入参 */
export function classifyInputFromDataUrl(
  url: string,
  filename: string,
): { filename: string; declaredMime: string; sizeBytes: number; headBytes: Uint8Array } | null {
  const parsed = parseDataUrl(url);
  if (parsed === null) return null;
  return {
    filename,
    declaredMime: parsed.mime,
    sizeBytes: sizeOfBase64(parsed.base64),
    headBytes: headBytesOf(parsed.base64),
  };
}
