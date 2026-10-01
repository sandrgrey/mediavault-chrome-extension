import { afterEach, expect, it, vi } from 'vitest';
import { createChromeDownloads } from '../../src/download/chromeDownloads';

afterEach(() => vi.unstubAllGlobals());
function api() {
  const changed = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const item = { id: 7, state: 'complete', filename: 'C:/Downloads/file.jpg',
    url: 'https://fixture.invalid/?secret=PRIVATE', finalUrl: 'https://fixture.invalid/PRIVATE',
    referrer: 'PRIVATE', exists: false, error: undefined };
  const download = vi.fn(async () => 7);
  const search = vi.fn(async () => [item]);
  vi.stubGlobal('chrome', { downloads: { download, search, onChanged: {
    addListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => changed.add(fn),
    removeListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => changed.delete(fn),
  } } });
  return { item, download, search, changed };
}
it('starts with a safe duplicate filename policy and returns only the ID', async () => {
  const fake = api();
  expect(await createChromeDownloads().start('https://fixture.invalid/a.jpg', 'MediaVault/a.jpg')).toBe(7);
  expect(fake.download).toHaveBeenCalledWith({ url: 'https://fixture.invalid/a.jpg', filename: 'MediaVault/a.jpg', conflictAction: 'uniquify', saveAs: false });
});
it('projects only safe fields and preserves historical success when the file was deleted', async () => {
  const fake = api();
  expect(await createChromeDownloads().get(7)).toEqual({ id: 7, state: 'complete', filename: 'C:/Downloads/file.jpg', errorCode: null });
  expect(fake.search).toHaveBeenCalledWith({ id: 7 });
});
it('returns null for erased history and maps interruption to a safe code', async () => {
  const fake = api();
  fake.item.state = 'interrupted';
  expect((await createChromeDownloads().get(7))?.errorCode).toBe('download-failed');
  fake.search.mockResolvedValue([]);
  expect(await createChromeDownloads().get(7)).toBeNull();
});
it('discards raw errors from failed Chrome calls', async () => {
  const fake = api();
  fake.search.mockRejectedValue(Error('PRIVATE signed URL'));
  fake.download.mockRejectedValue(Error('PRIVATE signed URL'));
  await expect(createChromeDownloads().get(7)).rejects.toThrow(/^download-failed$/);
  await expect(createChromeDownloads().start('https://fixture.invalid/a', 'a')).rejects.toThrow(/^download-failed$/);
});
it('forwards only the download ID and removes the listener on unsubscribe', () => {
  const fake = api();
  const received: unknown[] = [];
  const stop = createChromeDownloads().onChange(id => received.push(id));
  for (const fn of fake.changed) fn({ id: 7, url: { current: 'PRIVATE' } });
  stop();
  for (const fn of fake.changed) fn({ id: 8 });
  expect(received).toEqual([7]);
  expect(fake.changed.size).toBe(0);
});
