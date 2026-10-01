import type { ResolvedPublication } from './models';
import { publicationKey } from '../download/filenames';

const textOrNull = (value: unknown, max: number): boolean => value === null || (typeof value === 'string' && value.length <= max);
export function validResolved(publication: ResolvedPublication): boolean {
  if (!publication || typeof publication !== 'object') return false;
  const key = publicationKey(publication.sourceUrl);
  if (!key.ok || key.value !== publication.id || publication.provider !== 'instagram' ||
    publication.id !== `instagram:${publication.sourceIdentity}` ||
    !textOrNull(publication.author, 200) || !textOrNull(publication.caption, 10_000) ||
    !['photo', 'video', 'reel', 'carousel'].includes(publication.kind) ||
    !['complete', 'partial'].includes(publication.collectionStatus) ||
    !Array.isArray(publication.items) || publication.items.length < 1 || publication.items.length > 50) return false;
  if (publication.expectedCount !== null && (!Number.isInteger(publication.expectedCount) ||
    publication.expectedCount < publication.items.length || publication.expectedCount > 50)) return false;
  if (publication.collectionStatus === 'complete' && publication.expectedCount !== publication.items.length) return false;
  return publication.items.every((item, index) => {
    if (!item || item.index !== index || !['image', 'video'].includes(item.mediaType) ||
      (item.stableItemId !== null && (typeof item.stableItemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.stableItemId)))) return false;
    if (item.mediaType === 'video' ? item.extension !== 'mp4' : !['jpg', 'png', 'webp'].includes(item.extension)) return false;
    try { const url = new URL(item.downloadUrl); return url.protocol === 'https:' && !url.username && !url.password; }
    catch { return false; }
  });
}
