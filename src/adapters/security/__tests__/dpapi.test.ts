import { describe, expect, it } from 'vitest';

import { dpapiProtect, dpapiUnprotect } from '../dpapi.js';

const windows = process.platform === 'win32';

describe('Windows DPAPI', () => {
  it.skipIf(!windows)('加密后可解回，密文不含明文', async () => {
    const plain = 'butler-dpapi-测试-秘密-123';
    const cipher = await dpapiProtect(plain);
    expect(cipher.length).toBeGreaterThan(0);
    expect(cipher).not.toContain(plain);
    expect(await dpapiUnprotect(cipher)).toBe(plain);
  });
});
