import type { PublicationRecord } from '../domain/models';
import type { IDBPTransaction } from 'idb';
import type { MediaVaultDatabase, MediaVaultSchema } from '../storage/database';
import { fail, ok, type Result } from '../shared/result';

export function createLibraryRepository(db: MediaVaultDatabase) {
  return {
    async get(id: string): Promise<PublicationRecord | null> { return await db.get('publications', id) ?? null; },
    async list(): Promise<PublicationRecord[]> { return (await db.getAllFromIndex('publications', 'savedAt')).reverse(); },
    async remove(id: string): Promise<Result<void>> {
      const stores = ['publications', 'operations', 'activePublications', 'sourceIntents'] as const;
      let tx: IDBPTransaction<MediaVaultSchema, typeof stores, 'readwrite'>;
      try { tx = db.transaction(stores, 'readwrite'); }
      catch { return fail('storage-failed'); }
      const done = tx.done;
      void done.catch(() => undefined);
      try {
        if (await tx.objectStore('activePublications').get(id)) { await done; return fail('busy'); }
        await tx.objectStore('publications').delete(id);
        const operations = tx.objectStore('operations');
        for (const key of await operations.index('publicationId').getAllKeys(id)) await operations.delete(key);
        const intents = tx.objectStore('sourceIntents');
        for (const key of await intents.index('publicationId').getAllKeys(id)) await intents.delete(key);
        await done; return ok(undefined);
      } catch {
        try { tx.abort(); } catch { /* Transaction already closed. */ }
        await done.catch(() => undefined);
        return fail('storage-failed');
      }
    },
  };
}
export type LibraryRepository = ReturnType<typeof createLibraryRepository>;
