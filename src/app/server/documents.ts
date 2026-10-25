import { join } from 'node:path';

import { DocumentStore } from '@/core/documents/store.js';

let store: DocumentStore | null = null;

export function getDocumentStore(): DocumentStore {
  if (store === null) {
    const dir = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
    store = new DocumentStore(join(dir, 'documents'));
  }
  return store;
}
