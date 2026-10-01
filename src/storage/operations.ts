import type { IDBPTransaction } from 'idb';
import type { BeginInput, BeginOutcome, ItemState, OperationItem, OperationRecord, OperationState, SubmitInput } from '../domain/models';
import { cleanMetadata, toPublicationRecord } from '../domain/persistence';
import { isFullySaved, selectItems } from '../domain/selectItems';
import { validResolved } from '../domain/validation';
import { buildDownloadPath } from '../download/filenames';
import { fail, isErrorCode, ok, type Result } from '../shared/result';
import type { MediaVaultDatabase, MediaVaultSchema } from './database';
import { reelIdentity } from '../providers/instagram/reelIdentity';

const stores = ['operations', 'publications', 'activePublications'] as const;
type WriteTransaction = IDBPTransaction<MediaVaultSchema, typeof stores, 'readwrite'>;
const sameOwner = (a: OperationRecord['owner'], b: OperationRecord['owner']): boolean => a.tabId === b.tabId && a.documentId === b.documentId;
const activeStates = new Set<OperationState>(['collecting', 'downloading', 'stopping', 'uncertain']);
const transitions: Record<ItemState, readonly ItemState[]> = {
  pending: ['dispatching', 'cancelled'], dispatching: ['downloading', 'failed', 'uncertain'],
  downloading: ['completed', 'failed', 'uncertain'], uncertain: ['downloading', 'completed', 'failed'],
  completed: [], failed: [], cancelled: [],
};

export function createOperationRepository(db: MediaVaultDatabase) {
  async function write<T>(action: (tx: WriteTransaction) => Promise<Result<T>>): Promise<Result<T>> {
    let tx: WriteTransaction;
    try { tx = db.transaction(stores, 'readwrite'); }
    catch { return fail('storage-failed'); }
    const done = tx.done;
    void done.catch(() => undefined);
    try {
      const result = await action(tx);
      if (!result.ok) { tx.abort(); await done.catch(() => undefined); return result; }
      await done;
      return result;
    } catch {
      try { tx.abort(); } catch { /* Already aborted or closed. */ }
      await done.catch(() => undefined);
      return fail('storage-failed');
    }
  }
  async function project(tx: WriteTransaction, operation: OperationRecord): Promise<void> {
    if (operation.superseded || !operation.metadata) return;
    const publications = tx.objectStore('publications');
    const previous = await publications.get(operation.publicationId) ?? null;
    const record = toPublicationRecord(operation, previous, operation.updatedAt);
    if (record.ok) await publications.put(record.value);
    else if (record.error !== 'storage-empty-record') throw new Error('invalid-projection');
  }
  return {
    async attachReelResult(id: string, owner: BeginInput['owner'], sourceUrl: string, nowMs: number): Promise<Result<void>> {
      const identity = reelIdentity(sourceUrl);
      if (!identity.ok || !Number.isFinite(nowMs)) return fail('invalid-message');
      return write(async tx => {
        const ops = tx.objectStore('operations'), operation = await ops.get(id);
        if (!operation || operation.superseded || !sameOwner(operation.owner, owner) ||
          operation.publicationId !== identity.value.publicationId || operation.state !== 'collecting') return fail('invalid-message');
        if (operation.cancelRequested) return fail('cancelled');
        if (nowMs > operation.collectDeadlineMs) return fail('operation-expired');
        if (operation.mode === 'retry') return fail('identity-unavailable');
        const metadata = { id: identity.value.publicationId, provider: 'instagram' as const,
          sourceIdentity: identity.value.sourceIdentity, sourceUrl: identity.value.sourceUrl, author: null, caption: null, kind: 'reel' as const };
        operation.metadata = metadata; operation.collectionStatus = 'complete'; operation.expectedCount = 1;
        operation.items = [{ index: 0, stableItemId: null, mediaType: 'video', status: 'pending', downloadId: null, errorCode: null,
          filename: buildDownloadPath(metadata, { index: 0, mediaType: 'video', extension: 'mp4' }) }];
        operation.state = 'downloading'; operation.updatedAt = new Date(nowMs).toISOString();
        await ops.put(operation); return ok(undefined);
      });
    },
    async begin(input: BeginInput): Promise<Result<BeginOutcome>> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !/^instagram:[A-Za-z0-9_-]{1,64}$/.test(input.publicationId) ||
        !['save', 'retry', 'redownload'].includes(input.mode) || !Number.isFinite(input.nowMs) || input.nowMs < 0 ||
        !Number.isInteger(input.owner.tabId) || input.owner.tabId < 0 || !input.owner.documentId || input.owner.documentId.length > 200)
        return fail('invalid-message');
      return write<BeginOutcome>(async tx => {
        const ops = tx.objectStore('operations'), active = tx.objectStore('activePublications');
        const repeated = await ops.index('requestId').get(input.requestId);
        if (repeated) return sameOwner(repeated.owner, input.owner) && repeated.publicationId === input.publicationId && repeated.mode === input.mode
          ? ok({ kind: 'accepted', operationId: repeated.id }) : fail('invalid-message');
        const reservation = await active.get(input.publicationId);
        const existing = reservation ? await ops.get(reservation.operationId) : undefined;
        if (existing && existing.state === 'collecting' && existing.collectDeadlineMs < input.nowMs) {
          existing.state = 'needs-user'; await ops.put(existing); await active.delete(input.publicationId);
        } else if (existing?.state === 'uncertain') {
          if (input.mode !== 'redownload') return ok({ kind: 'needs-review' });
          if (existing.items.some(item => item.status === 'downloading' || (item.status === 'dispatching' && item.downloadId !== null))) return ok({ kind: 'busy' });
          existing.superseded = true; await ops.put(existing); await active.delete(input.publicationId);
        } else if (existing && activeStates.has(existing.state)) return ok({ kind: 'busy' });
        const previous = await tx.objectStore('publications').get(input.publicationId);
        if (previous && input.mode === 'save') return ok({ kind: isFullySaved(previous) ? 'already-saved' : 'retry-required' });
        const date = new Date(input.nowMs).toISOString();
        const operation: OperationRecord = {
          id: crypto.randomUUID(), requestId: input.requestId, publicationId: input.publicationId,
          mode: input.mode, owner: { tabId: input.owner.tabId, documentId: input.owner.documentId },
          state: 'collecting', collectDeadlineMs: input.nowMs + 150_000, metadata: null,
          collectionStatus: 'partial', expectedCount: null, items: [], cancelRequested: false,
          createdAt: date, updatedAt: date, superseded: false,
        };
        await ops.put(operation); await active.put({ publicationId: operation.publicationId, operationId: operation.id });
        return ok({ kind: 'accepted', operationId: operation.id });
      });
    },
    async get(id: string): Promise<OperationRecord | null> { return await db.get('operations', id) ?? null; },
    async findRecoverable(): Promise<OperationRecord[]> {
      return (await db.getAll('operations')).filter(op => !op.superseded && activeStates.has(op.state));
    },
    async attachCollection(input: SubmitInput, nowMs = Date.now()): Promise<Result<void>> {
      if (!validResolved(input.publication) || !Number.isFinite(nowMs)) return fail('invalid-message');
      return write(async tx => {
        const ops = tx.objectStore('operations'), operation = await ops.get(input.operationId);
        if (!operation || operation.superseded || !sameOwner(operation.owner, input.owner) ||
          operation.publicationId !== input.publication.id) return fail('invalid-message');
        if (operation.cancelRequested) return fail('cancelled');
        if (operation.state !== 'collecting') return fail('invalid-message');
        if (nowMs > operation.collectDeadlineMs) return fail('operation-expired');
        const previous = await tx.objectStore('publications').get(operation.publicationId) ?? null;
        const selected = selectItems(operation.mode, input.publication, previous);
        if (!selected.ok) return selected;
        const pending = new Set(selected.value.map(item => item.index));
        operation.metadata = cleanMetadata(input.publication);
        operation.collectionStatus = input.publication.collectionStatus;
        operation.expectedCount = input.publication.expectedCount;
        operation.items = input.publication.items.map(item => {
          const prior = !pending.has(item.index) && item.stableItemId
            ? previous?.items.find(old => old.stableItemId === item.stableItemId && old.status === 'completed') : undefined;
          return { index: item.index, stableItemId: item.stableItemId, mediaType: item.mediaType,
            filename: prior?.filename ?? buildDownloadPath(input.publication, item), downloadId: prior?.downloadId ?? null,
            status: prior ? 'completed' : 'pending', errorCode: null };
        });
        operation.state = 'downloading'; operation.updatedAt = new Date(nowMs).toISOString();
        await ops.put(operation);
        return ok(undefined);
      });
    },
    async transitionItem(id: string, index: number, from: ItemState, to: ItemState,
      patch: Partial<Pick<OperationItem, 'downloadId' | 'errorCode' | 'filename'>>): Promise<Result<void>> {
      if (patch.downloadId !== undefined && patch.downloadId !== null && (!Number.isInteger(patch.downloadId) || patch.downloadId < 0)) return fail('invalid-message');
      if (patch.errorCode !== undefined && patch.errorCode !== null && !isErrorCode(patch.errorCode)) return fail('invalid-message');
      return write(async tx => {
        const ops = tx.objectStore('operations'), operation = await ops.get(id);
        if (!operation || operation.superseded) return fail('invalid-message');
        if (to === 'dispatching' && operation.cancelRequested) return fail('cancelled');
        const item = operation.items.find(item => item.index === index);
        if (!item || (patch.filename !== undefined && patch.filename !== item.filename)) return fail('invalid-message');
        if (item.status === to && (patch.downloadId === undefined || item.downloadId === patch.downloadId)) return ok(undefined);
        if (item.status !== from || !transitions[from]?.includes(to)) return fail('invalid-message');
        const downloadId = patch.downloadId !== undefined ? patch.downloadId : item.downloadId;
        if ((to === 'downloading' || to === 'completed') && downloadId === null) return fail('invalid-message');
        item.status = to; item.downloadId = downloadId;
        item.errorCode = to === 'completed' ? null : (patch.errorCode !== undefined ? patch.errorCode : item.errorCode);
        operation.updatedAt = new Date().toISOString();
        await ops.put(operation); await project(tx, operation);
        return ok(undefined);
      });
    },
    async requestCancel(id: string): Promise<Result<void>> {
      return write(async tx => {
        const ops = tx.objectStore('operations'), operation = await ops.get(id);
        if (!operation || operation.superseded) return fail('invalid-message');
        if (!activeStates.has(operation.state)) return ok(undefined);
        operation.cancelRequested = true;
        for (const item of operation.items) if (item.status === 'pending') { item.status = 'cancelled'; item.errorCode = 'cancelled'; }
        const hasRunning = operation.items.some(item => ['downloading', 'dispatching', 'uncertain'].includes(item.status));
        operation.state = hasRunning ? 'stopping' : 'cancelled'; operation.updatedAt = new Date().toISOString();
        await ops.put(operation); await project(tx, operation);
        if (!hasRunning) await tx.objectStore('activePublications').delete(operation.publicationId);
        return ok(undefined);
      });
    },
    async settle(id: string, state: OperationState, now: string): Promise<Result<void>> {
      if (!Number.isFinite(Date.parse(now))) return fail('invalid-message');
      return write(async tx => {
        const ops = tx.objectStore('operations'), operation = await ops.get(id);
        if (!operation || operation.superseded) return fail('invalid-message');
        if (operation.cancelRequested && state !== 'completed' && !activeStates.has(state)) state = 'cancelled';
        if (state === 'completed' && (operation.collectionStatus !== 'complete' ||
          operation.expectedCount !== operation.items.length || !operation.items.length ||
          operation.items.some(item => item.status !== 'completed'))) return fail('invalid-message');
        if (!activeStates.has(state) && operation.items.some(item => ['downloading', 'dispatching', 'uncertain'].includes(item.status))) return fail('busy');
        operation.state = state; operation.updatedAt = now;
        await ops.put(operation); await project(tx, operation);
        if (!activeStates.has(state)) {
          const active = tx.objectStore('activePublications');
          if ((await active.get(operation.publicationId))?.operationId === operation.id) await active.delete(operation.publicationId);
        }
        return ok(undefined);
      });
    },
  };
}
export type OperationRepository = ReturnType<typeof createOperationRepository>;
