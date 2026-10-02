import type { Owner, ResolvedPublication, SaveMode } from '../domain/models';
import type { OperationRepository } from '../storage/operations';
import type { DownloadsPort } from '../download/chromeDownloads';
import type { createOperationQueue } from './operationQueue';
import { postIdentity, photoUrl } from '../providers/instagram/photos';
import { validResolved } from '../domain/validation';
import { plain } from '../media/reelProtocol';
import { fail, ok, type Result } from '../shared/result';
export type PhotoBlob = { url: string; size: number };
export function validPhotos(p: ResolvedPublication, blobs: PhotoBlob[]): boolean {
  return validResolved(p) && ['photo', 'carousel'].includes(p.kind) && postIdentity(p.sourceUrl).ok &&
    (p.kind !== 'photo' || (p.items.length === 1 && p.expectedCount === 1 && p.collectionStatus === 'complete')) &&
    p.items.every(i => i.mediaType === 'image' && photoUrl(i.downloadUrl) && i.stableItemId === null) &&
    Array.isArray(blobs) && blobs.length === p.items.length && blobs.every(b => plain(b, ['url', 'size']) &&
      typeof b.url === 'string' && /^blob:https:\/\/www\.instagram\.com\/[a-f0-9-]{36}$/.test(b.url) && Number.isSafeInteger(b.size) && b.size > 0) &&
    blobs.reduce((sum, b) => sum + b.size, 0) <= 64 * 1024 * 1024;
}
export function createPhotoCoordinator(deps: { operations: OperationRepository; downloads: DownloadsPort; queue: ReturnType<typeof createOperationQueue>; live: Set<string>;
  verify: (owner: Owner, sourceUrl: string, id: string) => Promise<boolean> }) {
  const { operations, queue, live } = deps;
  return {
    async begin(owner: Owner, sourceUrl: string, requestId: string, mode: SaveMode) {
      const identity = postIdentity(sourceUrl); if (!identity.ok) return identity;
      return queue.run(async () => {
        const result = await operations.begin({ owner, publicationId: identity.value.publicationId, requestId, mode, nowMs: Date.now() });
        if (result.ok && result.value.kind === 'accepted') live.add(result.value.operationId);
        return result;
      });
    },
    async submit(owner: Owner, id: string, publication: ResolvedPublication, blobs: PhotoBlob[]): Promise<Result<void>> {
      if (!validPhotos(publication, blobs)) return fail('invalid-message');
      return queue.run(async () => {
        const op = await operations.get(id);
        if (!op || op.superseded || op.owner.tabId !== owner.tabId || op.owner.documentId !== owner.documentId || op.publicationId !== publication.id) return fail('invalid-message');
        if (op.cancelRequested) return fail('cancelled');
        if (op.state !== 'collecting') return ok(undefined);
        const valid = () => deps.verify(owner, publication.sourceUrl, id).catch(() => false);
        try {
          if (!await valid()) { await operations.requestCancel(id); return fail('publication-changed'); }
          const attached = await operations.attachCollection({ owner, operationId: id, publication }); if (!attached.ok) return attached;
          const current = await operations.get(id); if (!current) return fail('storage-failed');
          for (const item of current.items) {
            if (!await valid()) { await operations.requestCancel(id); return fail('publication-changed'); }
            const marked = await operations.transitionItem(id, item.index, 'pending', 'dispatching', {}); if (!marked.ok) return marked;
            if (!await valid()) {
              await operations.transitionItem(id, item.index, 'dispatching', 'failed', { errorCode: 'publication-changed' });
              await operations.requestCancel(id); return fail('publication-changed');
            }
            try {
              const downloadId = await deps.downloads.start(blobs[item.index].url, item.filename);
              const recorded = await operations.transitionItem(id, item.index, 'dispatching', 'downloading', { downloadId });
              if (!recorded.ok) throw Error('not-recorded');
            } catch {
              await operations.transitionItem(id, item.index, 'dispatching', 'uncertain', { errorCode: 'needs-review' });
              await operations.requestCancel(id); return fail('needs-review');
            }
          }
          return ok(undefined);
        } finally { live.delete(id); }
      });
    },
  };
}
