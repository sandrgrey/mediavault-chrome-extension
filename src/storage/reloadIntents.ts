import type { IDBPTransaction } from 'idb';
import type { Owner } from '../domain/models';
import { fail, ok, type Result } from '../shared/result';
import type { MediaVaultDatabase, MediaVaultSchema } from './database';
export type ReelSession = { operationId: string; token: string; deadlineMs: number };
export type ReloadIntent = { tabId: number; operationId: string; publicationId: string; oldDocumentId: string;
  phase: 'prepared' | 'reload-issued' | 'claimed'; token: string; expiresAtMs: number; claimedDocumentId: string | null };
const stores = ['reloadIntents', 'operations', 'activePublications'] as const;
type Tx = IDBPTransaction<MediaVaultSchema, typeof stores, 'readwrite'>;
const validOwner = (owner: Owner) => Number.isInteger(owner.tabId) && owner.tabId >= 0 && typeof owner.documentId === 'string' && owner.documentId.length > 0 && owner.documentId.length <= 200;
export function createReloadRepository(db: MediaVaultDatabase) {
  async function write<T>(action: (tx: Tx) => Promise<Result<T>>): Promise<Result<T>> {
    let tx: Tx;
    try { tx = db.transaction(stores, 'readwrite'); } catch { return fail('storage-failed'); }
    void tx.done.catch(() => undefined);
    try {
      const result = await action(tx);
      if (!result.ok) { tx.abort(); await tx.done.catch(() => undefined); return result; }
      await tx.done; return result;
    } catch {
      try { tx.abort(); } catch { /* already closed */ }
      await tx.done.catch(() => undefined); return fail('storage-failed');
    }
  }
  return {
    async prepare(operationId: string, owner: Owner, publicationId: string, nowMs: number): Promise<Result<ReloadIntent>> {
      if (!validOwner(owner) || !Number.isFinite(nowMs)) return fail('invalid-message');
      return write(async tx => {
        const operation = await tx.objectStore('operations').get(operationId);
        if (!operation || operation.superseded || operation.publicationId !== publicationId ||
          operation.owner.tabId !== owner.tabId || operation.owner.documentId !== owner.documentId) return fail('invalid-message');
        if (operation.cancelRequested) return fail('cancelled');
        if (nowMs > operation.collectDeadlineMs) return fail('operation-expired');
        if (operation.state !== 'collecting' || (await tx.objectStore('activePublications').get(publicationId))?.operationId !== operationId) return fail('invalid-message');
        const store = tx.objectStore('reloadIntents'), prior = await store.get(owner.tabId);
        if (prior?.operationId === operationId) return ok(prior);
        if (prior && prior.expiresAtMs >= nowMs) return fail('busy');
        const intent: ReloadIntent = { tabId: owner.tabId, operationId, publicationId, oldDocumentId: owner.documentId,
          phase: 'prepared', token: crypto.randomUUID(), expiresAtMs: operation.collectDeadlineMs, claimedDocumentId: null };
        await store.put(intent); return ok(intent);
      });
    },
    async markIssued(operationId: string): Promise<Result<boolean>> {
      return write(async tx => {
        const store = tx.objectStore('reloadIntents'), intent = await store.index('operationId').get(operationId);
        const operation = await tx.objectStore('operations').get(operationId);
        if (!intent || !operation || operation.superseded) return fail('invalid-message');
        if (operation.cancelRequested) return fail('cancelled');
        if (intent.phase !== 'prepared') return ok(false);
        intent.phase = 'reload-issued'; await store.put(intent); return ok(true);
      });
    },
    async claim(owner: Owner, publicationId: string, nowMs: number): Promise<Result<ReelSession | null>> {
      if (!validOwner(owner) || !Number.isFinite(nowMs)) return fail('invalid-message');
      return write<ReelSession | null>(async tx => {
        const store = tx.objectStore('reloadIntents'), intent = await store.get(owner.tabId);
        if (!intent) return ok(null);
        const ops = tx.objectStore('operations'), operation = await ops.get(intent.operationId);
        if (!operation || operation.superseded || intent.publicationId !== publicationId || operation.publicationId !== publicationId ||
          intent.phase === 'prepared' || owner.documentId === intent.oldDocumentId ||
          (intent.claimedDocumentId !== null && intent.claimedDocumentId !== owner.documentId)) return fail('invalid-message');
        if (operation.cancelRequested) return fail('cancelled');
        if (nowMs > intent.expiresAtMs || nowMs > operation.collectDeadlineMs) return fail('operation-expired');
        if (operation.state !== 'collecting' || operation.owner.tabId !== owner.tabId ||
          operation.owner.documentId !== (intent.claimedDocumentId ?? intent.oldDocumentId) ||
          (await tx.objectStore('activePublications').get(publicationId))?.operationId !== operation.id) return fail('invalid-message');
        intent.phase = 'claimed'; intent.claimedDocumentId = owner.documentId; operation.owner = { ...owner };
        await ops.put(operation); await store.put(intent);
        return ok({ operationId: operation.id, token: intent.token, deadlineMs: intent.expiresAtMs });
      });
    },
    async remove(operationId: string): Promise<Result<void>> {
      return write(async tx => {
        const store = tx.objectStore('reloadIntents'), intent = await store.index('operationId').get(operationId);
        if (intent) await store.delete(intent.tabId);
        return ok(undefined);
      });
    },
  };
}
