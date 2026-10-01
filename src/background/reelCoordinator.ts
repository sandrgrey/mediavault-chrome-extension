import type { BeginOutcome, Owner, OperationState, SaveMode } from '../domain/models';
import type { ReelIdentity } from '../providers/instagram/reelIdentity';
import { parseReelMessage, type ReadyBlob } from '../shared/reelMessages';
import { fail, ok, type Result } from '../shared/result';
import type { OperationRepository } from '../storage/operations';
import type { createReloadRepository, ReelSession } from '../storage/reloadIntents';
import type { DownloadsPort } from '../download/chromeDownloads';
import type { createOperationQueue } from './operationQueue';
export type ReelStatus = { state: OperationState; safeToRelease: boolean };
export type CoordinatorDeps = { operations: OperationRepository; reloads: ReturnType<typeof createReloadRepository>; downloads: DownloadsPort;
  queue: ReturnType<typeof createOperationQueue>; live: Set<string>; recover: () => Promise<Result<void>>;
  verifyContext: (owner: Owner, identity: ReelIdentity, operationId: string) => Promise<boolean>;
  reloadTab: (tabId: number) => Promise<void>; cancelDownload: (id: number) => Promise<void>; now: () => number };
export function createReelCoordinator(deps: CoordinatorDeps) {
  const { operations, reloads, downloads, queue, live, recover, now } = deps;
  async function owned(owner: Owner, id: string) {
    const op = await operations.get(id);
    return op && !op.superseded && op.owner.tabId === owner.tabId && op.owner.documentId === owner.documentId ? op : null;
  }
  async function view(owner: Owner, id: string): Promise<Result<ReelStatus>> {
    const op = await owned(owner, id);
    if (!op) return fail('invalid-message');
    return ok({ state: op.state, safeToRelease: !op.items.some(item => ['dispatching', 'downloading', 'uncertain'].includes(item.status)) });
  }
  async function status(owner: Owner, id: string): Promise<Result<ReelStatus>> {
    const result = await recover(); if (!result.ok) return result;
    return queue.run(() => view(owner, id));
  }
  return {
    async begin(owner: Owner, identity: ReelIdentity, requestId: string, mode: SaveMode): Promise<Result<BeginOutcome>> {
      return queue.run(async () => {
        const result = await operations.begin({ owner, publicationId: identity.publicationId, requestId, mode, nowMs: now() });
        if (!result.ok || result.value.kind !== 'accepted') return result;
        const id = result.value.operationId;
        const prepared = await reloads.prepare(id, owner, identity.publicationId, now());
        if (!prepared.ok) return prepared;
        const issued = await reloads.markIssued(id);
        if (!issued.ok) return issued;
        if (issued.value) {
          try { await deps.reloadTab(owner.tabId); }
          catch { await operations.requestCancel(id); await reloads.remove(id); return fail('unavailable'); }
        }
        return result;
      });
    },
    async claim(owner: Owner, identity: ReelIdentity): Promise<Result<ReelSession | null>> {
      return queue.run(async () => {
        const result = await reloads.claim(owner, identity.publicationId, now());
        if (result.ok && result.value) live.add(result.value.operationId);
        return result;
      });
    },
    async submit(owner: Owner, identity: ReelIdentity, blob: ReadyBlob): Promise<Result<ReelStatus>> {
      if (!parseReelMessage({ version: 1, type: 'reel-submit', result: blob })) return fail('invalid-message');
      const dispatched = await queue.run(async (): Promise<Result<void>> => {
        const op = await owned(owner, blob.operationId);
        if (!op || op.publicationId !== identity.publicationId) return fail('invalid-message');
        if (op.cancelRequested) return fail('cancelled');
        if (op.state !== 'collecting') return ok(undefined); // Repeat cannot dispatch a second time.
        if (!live.has(op.id)) {
          const reclaimed = await reloads.claim(owner, identity.publicationId, now());
          if (!reclaimed.ok || reclaimed.value?.operationId !== op.id) return fail('needs-review');
          live.add(op.id);
        }
        const contextValid = () => deps.verifyContext(owner, identity, op.id).catch(() => false);
        async function abandon() {
          await operations.requestCancel(op!.id);
          live.delete(op!.id); await reloads.remove(op!.id);
          return fail('publication-changed');
        }
        if (!await contextValid()) return abandon();
        const attached = await operations.attachReelResult(op.id, owner, identity.sourceUrl, now());
        if (!attached.ok) return attached;
        const pending = await operations.get(op.id);
        if (!pending?.items[0]) return fail('storage-failed');
        const marked = await operations.transitionItem(op.id, 0, 'pending', 'dispatching', {});
        if (!marked.ok) return marked;
        if (!await contextValid()) {
          const stopped = await operations.transitionItem(op.id, 0, 'dispatching', 'failed', { errorCode: 'publication-changed' });
          if (!stopped.ok) return stopped;
          return abandon();
        }
        try {
          const id = await downloads.start(blob.blobUrl, pending.items[0].filename);
          const recorded = await operations.transitionItem(op.id, 0, 'dispatching', 'downloading', { downloadId: id });
          if (!recorded.ok) {
            await operations.transitionItem(op.id, 0, 'dispatching', 'uncertain', { errorCode: 'needs-review' });
          }
        } catch {
          await operations.transitionItem(op.id, 0, 'dispatching', 'uncertain', { errorCode: 'needs-review' });
        } finally {
          live.delete(op.id); await reloads.remove(op.id);
        }
        return ok(undefined);
      });
      if (!dispatched.ok) return dispatched;
      return status(owner, blob.operationId);
    },
    async cancel(owner: Owner, operationId: string): Promise<Result<ReelStatus>> {
      const result = await queue.run(async (): Promise<Result<void>> => {
        const op = await owned(owner, operationId); if (!op) return fail('invalid-message');
        const cancelled = await operations.requestCancel(operationId); if (!cancelled.ok) return cancelled;
        live.delete(operationId); await reloads.remove(operationId);
        for (const item of op.items) if (item.downloadId !== null && ['downloading', 'uncertain'].includes(item.status)) {
          try { await deps.cancelDownload(item.downloadId); } catch { /* retain Blob and reconcile, never claim cancellation */ }
        }
        return ok(undefined);
      });
      return result.ok ? status(owner, operationId) : result;
    },
    status,
  };
}
