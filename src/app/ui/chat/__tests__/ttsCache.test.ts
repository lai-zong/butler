import { describe, expect, it } from 'vitest';
import { TtsBlobCache, ttsCacheKey } from '../ttsCache.js';

const CONFIG = {
  profileId: 'p1',
  modelId: 'm1',
  voice: '冰糖',
  style: '自然',
  format: 'mp3',
};

function blob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' });
}

describe('TtsBlobCache', () => {
  it('相同消息和配置命中缓存，换配置不命中', () => {
    const cache = new TtsBlobCache();
    const key = ttsCacheKey('m1', '你好', CONFIG);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, blob(10));
    expect(cache.get(key)?.size).toBe(10);
    expect(cache.get(ttsCacheKey('m1', '你好', { ...CONFIG, voice: '茉莉' }))).toBeUndefined();
    expect(cache.get(ttsCacheKey('m1', '你好啊', CONFIG))).toBeUndefined();
  });

  it('按条目数量淘汰最久未使用项', () => {
    const cache = new TtsBlobCache(2, 1000);
    cache.set('a', blob(1));
    cache.set('b', blob(1));
    expect(cache.get('a')?.size).toBe(1);
    cache.set('c', blob(1));
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.size).toBe(1);
  });

  it('超过总字节上限时不缓存', () => {
    const cache = new TtsBlobCache(10, 10);
    cache.set('big', blob(11));
    expect(cache.get('big')).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });
});
