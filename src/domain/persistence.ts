import type { MediaItemRecord, OperationItem, OperationRecord, PublicationMetadata, PublicationRecord } from './models';
import { fail, ok, type Result } from '../shared/result';

export function cleanMetadata(metadata: PublicationMetadata): PublicationMetadata {
  const source = new URL(metadata.sourceUrl);
  source.search = ''; source.hash = '';
  return { id: metadata.id, provider: metadata.provider, sourceIdentity: metadata.sourceIdentity,
    sourceUrl: source.href, author: metadata.author, caption: metadata.caption, kind: metadata.kind };
}

export function cleanItem(item: OperationItem | MediaItemRecord): MediaItemRecord {
  return { index: item.index, stableItemId: item.stableItemId, mediaType: item.mediaType,
    filename: item.filename, downloadId: item.downloadId, status: item.status === 'completed' ? 'completed' : 'failed',
    errorCode: item.status === 'completed' ? null : (item.errorCode ?? 'download-failed') };
}

export function cleanRecord(record: PublicationRecord): PublicationRecord {
  return { ...cleanMetadata(record), savedAt: record.savedAt, updatedAt: record.updatedAt, thumbnail: null,
    collectionStatus: record.collectionStatus, expectedCount: record.expectedCount, items: record.items.map(cleanItem) };
}

export function toPublicationRecord(operation: OperationRecord, previous: PublicationRecord | null, now: string): Result<PublicationRecord> {
  if (!operation.metadata || operation.metadata.id !== operation.publicationId ||
    (previous && previous.id !== operation.publicationId)) return fail('invalid-message');
  if (operation.superseded) return previous ? ok(cleanRecord(previous)) : fail('storage-empty-record');

  const fullySuccessful = operation.collectionStatus === 'complete' &&
    operation.expectedCount === operation.items.length && operation.items.length > 0 &&
    operation.items.every(item => item.status === 'completed');
  const sameSnapshot = previous && previous.items.length === operation.items.length &&
    previous.items.every((item, index) => item.stableItemId && item.stableItemId === operation.items[index].stableItemId);
  if (previous && operation.mode === 'redownload' && !sameSnapshot && !fullySuccessful) return ok(cleanRecord(previous));

  const oldSuccessful = new Map(previous?.items.filter(item => item.status === 'completed' && item.stableItemId)
    .map(item => [item.stableItemId, item]));
  const items = operation.items.toSorted((a, b) => a.index - b.index).map(item => {
    const prior = item.stableItemId ? oldSuccessful.get(item.stableItemId) : undefined;
    return cleanItem(item.status !== 'completed' && prior ? { ...prior, index: item.index } : item);
  });
  if (!items.some(item => item.status === 'completed')) return fail('storage-empty-record');
  try {
    return ok({ ...cleanMetadata(operation.metadata), savedAt: previous?.savedAt ?? now, updatedAt: now,
      thumbnail: null, collectionStatus: operation.collectionStatus, expectedCount: operation.expectedCount, items });
  } catch { return fail('invalid-message'); }
}
