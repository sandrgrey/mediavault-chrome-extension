import { fail, ok, type Result } from '../../shared/result';
import { publicationKey } from '../../download/filenames';
export type ReelIdentity = { publicationId: string; sourceIdentity: string; sourceUrl: string };
export function reelIdentity(value: string): Result<ReelIdentity> {
  const key = publicationKey(value);
  if (!key.ok) return key;
  const url = new URL(value);
  const match = /^\/reels?\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
  if (!match) return fail('unsupported-page');
  return ok({ publicationId: key.value, sourceIdentity: match[1], sourceUrl: `https://www.instagram.com/reel/${match[1]}/` });
}
