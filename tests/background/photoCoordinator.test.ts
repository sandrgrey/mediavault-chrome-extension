import { expect, it } from 'vitest';
import { openMediaVaultDatabase } from '../../src/storage/database';
import { createOperationRepository } from '../../src/storage/operations';
import { createOperationQueue } from '../../src/background/operationQueue';
import { createPhotoCoordinator } from '../../src/background/photoCoordinator';
import { createRecovery } from '../../src/background/recovery';
import type { ResolvedPublication } from '../../src/domain/models';
it('dispatches a photo once and persists neither page Blob nor CDN URLs', async () => {
  const db = await openMediaVaultDatabase(crypto.randomUUID());
  try {
    const operations = createOperationRepository(db), queue = createOperationQueue(), live = new Set<string>(); let starts = 0;
    const downloads = { start: async () => ++starts, get: async (id: number) => ({ id, filename: 'photo.jpg', state: 'complete' as const, errorCode: null }), onChange: () => () => {} };
    const recover = createRecovery(operations, downloads, Date.now, { queue, live });
    const coordinator = createPhotoCoordinator({ operations, queue, live, downloads, verify: async () => true });
    const owner = { tabId: 1, documentId: 'doc' };
    const begun = await coordinator.begin(owner, 'https://www.instagram.com/p/Fixture/', 'req', 'save');
    if (!begun.ok || begun.value.kind !== 'accepted') throw Error('begin');
    const p: ResolvedPublication = { id: 'instagram:Fixture', provider: 'instagram', sourceIdentity: 'Fixture', sourceUrl: 'https://www.instagram.com/p/Fixture/', kind: 'photo', author: null, caption: null, expectedCount: 1, collectionStatus: 'complete', items: [{ index: 0, stableItemId: null, mediaType: 'image', extension: 'jpg', downloadUrl: 'https://scontent-lax3-2.cdninstagram.com/p.jpg' }] };
    const blobs = [{ url: 'blob:https://www.instagram.com/12345678-abcd-1234-abcd-123456789abc', size: 10 }];
    expect((await coordinator.submit(owner, begun.value.operationId, p, blobs)).ok).toBe(true);
    await coordinator.submit(owner, begun.value.operationId, p, blobs); await recover();
    expect(starts).toBe(1);
    expect((await operations.get(begun.value.operationId))?.state).toBe('completed');
    expect(JSON.stringify(await db.getAll('operations'))).not.toMatch(/blob:|cdninstagram/);
  } finally { db.close(); }
});
