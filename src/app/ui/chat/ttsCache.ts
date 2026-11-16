/**
 * 对话朗读的内存音频缓存。
 *
 * ★ 只缓存云端 TTS 返回的 Blob，不落盘、不跨页面刷新。
 * ★ key 包含消息 id、文本 hash 和完整 TTS 配置：换音色/模型/格式后不会误用旧音频。
 * ★ 有数量和字节上限；超出后淘汰最久未使用的条目，防止长对话无限占内存。
 */

export interface TtsCacheConfig {
  readonly profileId: string;
  readonly modelId: string;
  readonly voice: string;
  readonly style: string;
  readonly format: string;
}

export interface TtsCacheEntry {
  readonly blob: Blob;
  readonly bytes: number;
  usedAt: number;
}

function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function ttsCacheKey(id: string, text: string, config: TtsCacheConfig): string {
  return [
    id,
    text.length.toString(36),
    hashText(text),
    config.profileId,
    config.modelId,
    config.voice,
    config.style,
    config.format,
  ].join('|');
}

export class TtsBlobCache {
  private readonly entries = new Map<string, TtsCacheEntry>();
  private bytes = 0;
  private tick = 0;

  constructor(
    private readonly maxEntries = 12,
    private readonly maxBytes = 24 * 1024 * 1024,
  ) {}

  get(key: string): Blob | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    entry.usedAt = ++this.tick;
    return entry.blob;
  }

  set(key: string, blob: Blob): void {
    this.delete(key);
    const bytes = blob.size;
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { blob, bytes, usedAt: ++this.tick });
    this.bytes += bytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.usedAt < oldestAt) {
          oldestAt = entry.usedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.delete(oldestKey);
    }
  }
}
