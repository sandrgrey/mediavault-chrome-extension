import type { PublicationRecord, ResolvedMediaItem, ResolvedPublication, SaveMode } from './models';
import { fail, ok, type Result } from '../shared/result';

export function isFullySaved(record: PublicationRecord): boolean {
  return record.collectionStatus === 'complete' && record.items.length > 0 &&
    record.expectedCount === record.items.length && record.items.every(item => item.status === 'completed');
}

export function selectItems(mode: SaveMode, resolved: ResolvedPublication, previous: PublicationRecord | null): Result<ResolvedMediaItem[]> {
  if (previous && previous.id !== resolved.id) return fail('source-changed');
  if (!previous || mode === 'redownload') return ok([...resolved.items]);
  if (mode === 'save') return isFullySaved(previous) ? ok([]) : fail('partial-carousel');

  const oldIds = previous.items.map(item => item.stableItemId);
  const newIds = resolved.items.map(item => item.stableItemId);
  if ([...oldIds, ...newIds].some(id => !id) || new Set(oldIds).size !== oldIds.length ||
    new Set(newIds).size !== newIds.length) return fail('identity-unavailable');

  const positions = oldIds.map(id => newIds.indexOf(id));
  if (positions.some((position, i) => position < 0 || (i > 0 && position <= positions[i - 1])))
    return fail('source-changed');
  if (previous.collectionStatus === 'complete' &&
    (newIds.length !== oldIds.length || positions.some((position, index) => position !== index)))
    return fail('source-changed');

  const completed = new Set(previous.items.filter(item => item.status === 'completed').map(item => item.stableItemId));
  return ok(resolved.items.filter(item => !completed.has(item.stableItemId)));
}
