import { describe, expect, it } from 'vitest';
import { buildDownloadPath, mediaItemKey, publicationKey, sanitizePathSegment } from '../../src/download/filenames';
import { metadata, resolved } from '../helpers/domain';

describe('safe ordered download paths', () => {
  it.each([
    ['CON', '_CON'], ['NUL.txt', '_NUL.txt'], ['aux', '_aux'], ['\u2003', 'unknown-author'],
    ['a/b\\c:d', 'a-b-c-d'], ['name. ', 'name'], ['..', 'unknown-author'], ['a\u0000b', 'a-b'],
  ])('normalizes %j into a safe Windows path segment', (input, expected) => {
    expect(sanitizePathSegment(input, 'unknown-author')).toBe(expected);
  });
  it('bounds Unicode code points without splitting a surrogate pair', () => {
    expect(Array.from(sanitizePathSegment('😀'.repeat(121), 'x'))).toHaveLength(80);
  });
  it('does not accept an unsafe fallback', () => {
    expect(sanitizePathSegment(' ', '../')).not.toMatch(/[\\/]/);
    expect(sanitizePathSegment(' ', '../')).not.toBe('');
  });
  it('canonicalizes the same publication across route kinds and query strings', () => {
    expect(publicationKey('https://www.instagram.com/p/ABC123/?igsh=temporary#part')).toEqual({ ok: true, value: 'instagram:ABC123' });
    expect(publicationKey('https://www.instagram.com/reel/ABC123/')).toEqual({ ok: true, value: 'instagram:ABC123' });
  });
  it.each(['https://evil.test/p/ABC/', 'https://www.instagram.com.evil.test/p/ABC/', 'http://www.instagram.com/p/ABC/',
    'https://www.instagram.com/fixture/', 'https://user:pass@www.instagram.com/p/ABC/', 'invalid'])('rejects unsupported source %s', url => {
    expect(publicationKey(url)).toEqual({ ok: false, error: 'unsupported-page' });
  });
  it('preserves ordering and a supported image format', () => {
    const item = { ...resolved().items[1], extension: 'webp' as const };
    expect(buildDownloadPath(metadata, item)).toBe('MediaVault/instagram/fixture-author/ABC123/02-image.webp');
    expect(buildDownloadPath({ ...metadata, author: null }, resolved().items[0]))
      .toBe('MediaVault/instagram/unknown-author/ABC123/01-image.jpg');
  });
  it('uses stable keys independent of slide position', () => {
    expect(mediaItemKey(metadata.id, resolved().items[0])).toBe(mediaItemKey(metadata.id, { ...resolved().items[0], index: 4 }));
    expect(mediaItemKey(metadata.id, resolved().items[0])).not.toBe(mediaItemKey(metadata.id, resolved().items[1]));
  });
  it('rejects invalid ordering and a file extension inconsistent with its media type', () => {
    expect(() => buildDownloadPath(metadata, { ...resolved().items[0], index: -1 })).toThrow();
    expect(() => buildDownloadPath(metadata, { ...resolved().items[0], mediaType: 'video' })).toThrow();
  });
});
