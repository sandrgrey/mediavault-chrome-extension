import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OperationRecord, PublicationRecord } from '../domain/models';

export type StoredSourceIntent = { tabId: number; publicationId: string; mode: 'retry' | 'redownload'; expiresAtMs: number };
export interface MediaVaultSchema extends DBSchema {
  publications: { key: string; value: PublicationRecord; indexes: { sourceIdentity: string; savedAt: string } };
  operations: { key: string; value: OperationRecord; indexes: { requestId: string; publicationId: string; state: string } };
  activePublications: { key: string; value: { publicationId: string; operationId: string } };
  sourceIntents: { key: number; value: StoredSourceIntent; indexes: { publicationId: string } };
}
export type MediaVaultDatabase = IDBPDatabase<MediaVaultSchema>;
export function openMediaVaultDatabase(name = 'mediavault'): Promise<MediaVaultDatabase> {
  return openDB<MediaVaultSchema>(name, 1, {
    upgrade(db) {
      const publications = db.createObjectStore('publications', { keyPath: 'id' });
      publications.createIndex('sourceIdentity', 'sourceIdentity');
      publications.createIndex('savedAt', 'savedAt');
      const operations = db.createObjectStore('operations', { keyPath: 'id' });
      operations.createIndex('requestId', 'requestId', { unique: true });
      operations.createIndex('publicationId', 'publicationId');
      operations.createIndex('state', 'state');
      db.createObjectStore('activePublications', { keyPath: 'publicationId' });
      const intents = db.createObjectStore('sourceIntents', { keyPath: 'tabId' });
      intents.createIndex('publicationId', 'publicationId');
    },
  });
}
