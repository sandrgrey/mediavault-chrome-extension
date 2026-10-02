import type { CollectionProgress, ResolvedMediaItem, ResolvedPublication } from '../../domain/models';
import { publicationKey } from '../../download/filenames';
import { fail, ok, type Result, type MediaVaultErrorCode } from '../../shared/result';

const hosts = new Set(['scontent-lax3-1.cdninstagram.com', 'scontent-lax3-2.cdninstagram.com', 'scontent-lax7-1.cdninstagram.com']);
export function photoUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && hosts.has(u.hostname) && /\.(jpg|jpeg|png|webp)$/.test(u.pathname) ? u : null; }
  catch { return null; }
}
export function postIdentity(value: string) {
  const key = publicationKey(value);
  if (!key.ok) return key;
  const u = new URL(value), match = /^\/p\/([A-Za-z0-9_-]{1,64})\/?$/.exec(u.pathname);
  return match ? ok({ publicationId: key.value, sourceIdentity: match[1], sourceUrl: `https://www.instagram.com/p/${match[1]}/` }) : fail('unsupported-page');
}
function visible(e: Element) {
  const r = e.getBoundingClientRect();
  return r.width >= 160 && r.height >= 100 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
}
function offset(e: HTMLElement): number | null {
  const m = /^translateX\((-?\d+(?:\.\d+)?)px\)$/.exec(e.style.transform);
  return m ? Number(m[1]) : null;
}
export async function collectPhotos(options: { document: Document; location: () => URL; signal: AbortSignal; onProgress: (p: CollectionProgress) => void }): Promise<Result<ResolvedPublication>> {
  const { document: doc, signal } = options, identity = postIdentity(options.location().href);
  if (!identity.ok) return identity;
  const started = Date.now(), items: ResolvedMediaItem[] = [];
  let interrupted = false;
  const touched = (e: Event) => { if (e.isTrusted) interrupted = true; };
  const guard = (): MediaVaultErrorCode | null => {
    if (signal.aborted || interrupted) return 'cancelled';
    const current = postIdentity(options.location().href);
    if (!current.ok || current.value.publicationId !== identity.value.publicationId) return 'publication-changed';
    return Date.now() - started >= 120000 ? 'collection-timeout' : null;
  };
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 100));
  const images = () => [...doc.querySelectorAll<HTMLImageElement>('img')].filter(e => !e.closest('a') && e.naturalWidth >= 300 && e.complete && visible(e) && photoUrl(e.currentSrc));
  const first = images();
  const galleries = [...new Set(first.map(e => e.closest('ul')).filter((e): e is HTMLUListElement => !!e))];
  if (galleries.length > 1 || (!galleries.length && first.length !== 1)) return fail('media-not-found');
  const gallery = galleries[0] ?? null;
  let total: number | null = gallery ? null : 1;
  const result = (complete: boolean): Result<ResolvedPublication> => ok({ id: identity.value.publicationId, provider: 'instagram', sourceIdentity: identity.value.sourceIdentity,
    sourceUrl: identity.value.sourceUrl, author: null, caption: null, kind: gallery ? 'carousel' : 'photo',
    collectionStatus: complete ? 'complete' : 'partial', expectedCount: total, items });
  function read() {
    const candidates = images().filter(e => gallery ? e.closest('ul') === gallery : !e.closest('ul'));
    if (!gallery) return candidates.length === 1 ? { image: candidates[0], index: 0 } : null;
    let clip: HTMLElement | null = gallery.parentElement;
    while (clip && clip !== doc.body && !['auto', 'scroll', 'hidden'].includes(getComputedStyle(clip).overflowX)) clip = clip.parentElement;
    if (!clip || clip === doc.body) return null;
    const frame = clip.getBoundingClientRect();
    const active = candidates.filter(e => { const r = e.getBoundingClientRect(); return Math.abs(r.left - frame.left) < 2; });
    if (active.length !== 1) return null;
    const image = active[0], li = image.closest('li');
    if (!li || li.parentElement !== gallery) return null;
    const width = li.getBoundingClientRect().width, x = offset(li);
    const spacer = [...gallery.children].filter(e => e instanceof HTMLElement && e.style.width === '1px' && !e.querySelector('img,video')) as HTMLElement[];
    if (width < 160 || x === null || spacer.length !== 1) return null;
    const end = offset(spacer[0]); if (end === null) return null;
    const count = Math.round((end + 1) / width), index = Math.round(x / width);
    if (Math.abs(count * width - end - 1) > 2 || Math.abs(index * width - x) > 2 || count < 2 || count > 50 || index < 0 || index >= count) return null;
    if (total !== null && total !== count) { interrupted = true; return null; }
    total = count;
    const fromUrl = options.location().searchParams.get('img_index');
    if (fromUrl !== null && Number(fromUrl) !== index + 1) return null;
    return { image, index };
  }
  function button(label: string) {
    if (!gallery) return null;
    for (let p = gallery.parentElement, n = 0; p && p !== doc.body && n < 8; p = p.parentElement, n++) {
      const all = [...p.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)].filter(e => !e.hidden && !e.disabled && getComputedStyle(e).display !== 'none');
      if (all.length) return all.length === 1 ? all[0] : null;
    }
    return null;
  }
  async function wait(index: number) {
    const until = Date.now() + 10000;
    for (;;) {
      const error = guard(); if (error) throw error;
      const value = read();
      if (value?.index === index) { const source = value.image.currentSrc; await pause(); if (read()?.image.currentSrc === source && read()?.index === index) return value; }
      if (Date.now() >= until) throw 'collection-timeout';
      await pause();
    }
  }
  for (const type of ['pointerdown', 'keydown', 'wheel']) doc.addEventListener(type, touched, true);
  try {
    const error = guard(); if (error) return fail(error);
    let current = read(); if (!current) return fail('collection-incomplete');
    while (current.index > 0) {
      const back = button('Назад'); if (!back) return fail('collection-incomplete');
      back.click(); current = await wait(current.index - 1);
    }
    for (let index = 0; index < 50; index++) {
      current = await wait(index);
      const url = photoUrl(current.image.currentSrc); if (!url) return fail('unavailable');
      const ext = url.pathname.split('.').at(-1)!;
      items.push({ index, stableItemId: null, mediaType: 'image', extension: (ext === 'jpeg' ? 'jpg' : ext) as 'jpg' | 'png' | 'webp', downloadUrl: url.href });
      options.onProgress({ found: items.length, expected: total });
      if (total === items.length) return result(true);
      const next = button('Далее');
      if (!next) return result(false);
      next.click();
    }
    return result(false);
  } catch (error) {
    if (error === 'cancelled' || error === 'publication-changed') return fail(error);
    return items.length ? result(false) : fail('collection-timeout');
  } finally { for (const type of ['pointerdown', 'keydown', 'wheel']) doc.removeEventListener(type, touched, true); }
}
