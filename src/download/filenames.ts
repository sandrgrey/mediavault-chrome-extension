import type { PublicationMetadata, ResolvedMediaItem } from '../domain/models';
import { fail, ok, type Result } from '../shared/result';

function safeSegment(value: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '-').trim();
  safe = safe.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\s*\.|$)/i.test(safe)) safe = `_${safe}`;
  return Array.from(safe).slice(0, 80).join('').replace(/[.\s]+$/, '');
}
export function sanitizePathSegment(value: string, fallback: string): string {
  return safeSegment(value) || safeSegment(fallback) || 'unknown';
}
export function publicationKey(sourceUrl: string): Result<string> {
  try {
    const url = new URL(sourceUrl);
    const match = /^\/(?:p|reel|reels)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    if (url.origin !== 'https://www.instagram.com' || url.username || url.password || !match)
      return fail('unsupported-page');
    return ok(`instagram:${match[1]}`);
  } catch { return fail('unsupported-page'); }
}
export function mediaItemKey(publicationId: string, item: ResolvedMediaItem): string {
  return `${publicationId}:${item.stableItemId ? `id:${item.stableItemId}` : `position:${item.index}`}`;
}
export function buildDownloadPath(publication: PublicationMetadata, item: Pick<ResolvedMediaItem, 'index' | 'mediaType' | 'extension'>): string {
  if (!Number.isInteger(item.index) || item.index < 0 || item.index >= 50) throw new RangeError('invalid-media-index');
  const validExtension = item.mediaType === 'video' ? item.extension === 'mp4' : ['jpg', 'png', 'webp'].includes(item.extension);
  if (!validExtension) throw new Error('unsupported-media-format');
  return `MediaVault/instagram/${sanitizePathSegment(publication.author ?? '', 'unknown-author')}/` +
    `${sanitizePathSegment(publication.sourceIdentity, 'unknown-publication')}/` +
    `${String(item.index + 1).padStart(2, '0')}-${item.mediaType}.${item.extension}`;
}
