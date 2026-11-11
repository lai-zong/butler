import { join } from 'node:path';

import { DocumentStore } from '@/core/documents/store.js';

let store: DocumentStore | null = null;

export function getDocumentStore(): DocumentStore {
  if (store === null) {
    const dir = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
    // 文档有**自己的**存档区，不与记忆存档区合并
    store = new DocumentStore(join(dir, 'documents'), Date.now, join(dir, 'archive', 'documents'));
  }
  return store;
}
