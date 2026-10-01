import type { OperationRecord, PublicationMetadata, PublicationRecord, ResolvedPublication } from '../../src/domain/models';

export const metadata: PublicationMetadata = {
  id: 'instagram:ABC123', provider: 'instagram', sourceIdentity: 'ABC123',
  sourceUrl: 'https://www.instagram.com/p/ABC123/', author: 'fixture-author',
  caption: 'Synthetic publication', kind: 'carousel',
};
export function resolved(ids: (string | null)[] = ['a', 'b', 'c']): ResolvedPublication {
  return { ...metadata, collectionStatus: 'complete', expectedCount: ids.length,
    items: ids.map((stableItemId, index) => ({ stableItemId, index, mediaType: 'image', extension: 'jpg',
      downloadUrl: `https://fixture.invalid/${index}.jpg?temporary=SYNTHETIC_ONLY` })) };
}
export function previous(): PublicationRecord {
  return { ...metadata, savedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    thumbnail: null, collectionStatus: 'complete', expectedCount: 3,
    items: resolved().items.map(item => ({ index: item.index, stableItemId: item.stableItemId,
      mediaType: item.mediaType, filename: `${item.index + 1}.jpg`, downloadId: item.index + 10,
      status: item.index === 1 ? 'failed' : 'completed', errorCode: item.index === 1 ? 'download-failed' : null })) };
}
export function operation(): OperationRecord {
  return { id: 'operation-1', requestId: 'request-1', publicationId: metadata.id, mode: 'save',
    owner: { tabId: 1, documentId: 'document-1' }, state: 'downloading', collectDeadlineMs: 150_000,
    metadata: { ...metadata }, collectionStatus: 'complete', expectedCount: 3,
    items: previous().items.map(item => ({ ...item })), cancelRequested: false,
    createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', superseded: false };
}
