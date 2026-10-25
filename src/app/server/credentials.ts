import { join } from 'node:path';

import { dpapiProtect, dpapiUnprotect } from '@/adapters/security/dpapi.js';
import { CredentialVault, type CredentialCipher } from '@/core/security/vault.js';

const dpapi: CredentialCipher = {
  encrypt: dpapiProtect,
  decrypt: dpapiUnprotect,
};

let cached: Promise<CredentialVault> | null = null;

export function getCredentialVault(): Promise<CredentialVault> {
  if (cached === null) {
    const dir = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
    cached = Promise.resolve(new CredentialVault(join(dir, 'credentials.json'), dpapi));
  }
  return cached;
}
