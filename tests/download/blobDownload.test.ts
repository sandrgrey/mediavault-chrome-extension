import { afterEach, expect, it, vi } from 'vitest';
import { downloadMergedBlob } from '../../src/download/blobDownload';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fakeDownloads(state: string) {
  const listeners = new Set<(delta: { id: number }) => void>();
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.stubGlobal('chrome', { downloads: {
    onChanged: { addListener: (fn: (delta: { id: number }) => void) => listeners.add(fn), removeListener: (fn: (delta: { id: number }) => void) => listeners.delete(fn) },
    download: async () => 7,
    search: async () => [{ id: 7, state }],
    cancel: async () => { state = 'interrupted'; listeners.forEach(fn => fn({ id: 7 })); },
  } });
  return { revoke, listeners, finish: () => { state = 'complete'; listeners.forEach(fn => fn({ id: 7 })); } };
}
it('recognizes completion before the start promise resolved and releases the blob', async () => {
  const { revoke, listeners } = fakeDownloads('complete');
  expect(await downloadMergedBlob(new Blob(['mp4']))).toEqual({ ok: true });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});
it('keeps the blob alive until Chrome completes the download', async () => {
  const fake = fakeDownloads('in_progress');
  const result = downloadMergedBlob(new Blob(['mp4']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fake.revoke).not.toHaveBeenCalled();
  fake.finish();
  expect(await result).toEqual({ ok: true });
  expect(fake.revoke).toHaveBeenCalledTimes(1);
});
it('cancels a pending download and cleans up without returning success', async () => {
  const fake = fakeDownloads('in_progress');
  const controller = new AbortController();
  const result = downloadMergedBlob(new Blob(['mp4']), controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  expect(await result).toEqual({ ok: false, error: 'cancelled' });
  expect(fake.revoke).toHaveBeenCalledTimes(1);
  expect(fake.listeners.size).toBe(0);
});

it('does not start a download when already aborted', async () => {
  const fake = fakeDownloads('in_progress');
  const start = vi.spyOn(chrome.downloads, 'download');
  expect(await downloadMergedBlob(new Blob(['mp4']), AbortSignal.abort())).toEqual({ ok: false, error: 'cancelled' });
  expect(start).not.toHaveBeenCalled();
  expect(fake.revoke).not.toHaveBeenCalled();
});

it('waits for the ID before cancelling a start that is still pending', async () => {
  const fake = fakeDownloads('in_progress');
  let started!: (id: number) => void;
  vi.spyOn(chrome.downloads, 'download').mockImplementation(() => new Promise<number>(resolve => { started = resolve; }));
  const controller = new AbortController();
  const result = downloadMergedBlob(new Blob(['mp4']), controller.signal);
  controller.abort();
  expect(fake.revoke).not.toHaveBeenCalled();
  started(7);
  expect(await result).toEqual({ ok: false, error: 'cancelled' });
  expect(fake.revoke).toHaveBeenCalledTimes(1);
  expect(fake.listeners.size).toBe(0);
});

it('returns only a safe error and releases the Blob when Chrome rejects the start', async () => {
  const fake = fakeDownloads('in_progress');
  vi.spyOn(chrome.downloads, 'download').mockRejectedValue(new Error('private URL'));
  expect(await downloadMergedBlob(new Blob(['mp4']))).toEqual({ ok: false, error: 'download-failed' });
  expect(fake.revoke).toHaveBeenCalledTimes(1);
  expect(fake.listeners.size).toBe(0);
});

it('keeps the Blob after a failed cancel until a terminal event arrives', async () => {
  const fake = fakeDownloads('in_progress');
  vi.spyOn(chrome.downloads, 'cancel').mockRejectedValue(new Error('cancel failed'));
  const controller = new AbortController();
  const result = downloadMergedBlob(new Blob(['mp4']), controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fake.revoke).not.toHaveBeenCalled();
  fake.finish();
  expect(await result).toEqual({ ok: false, error: 'cancelled' });
  expect(fake.revoke).toHaveBeenCalledTimes(1);
});

it('uses uniquify and reports an interrupted download as failure', async () => {
  const fake = fakeDownloads('interrupted');
  const start = vi.spyOn(chrome.downloads, 'download');
  expect(await downloadMergedBlob(new Blob(['mp4']))).toEqual({ ok: false, error: 'download-failed' });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ filename: 'MediaVault/merged.mp4', conflictAction: 'uniquify' }));
  expect(fake.revoke).toHaveBeenCalledTimes(1);
});
