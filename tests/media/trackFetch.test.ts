import { afterEach, expect, it, vi } from 'vitest';
import { fetchTrackPair } from '../../src/media/trackFetch';
import { MAX_TRACK_BYTES } from '../../src/media/reelProtocol';
const pair = { videoUrl: 'https://scontent-lax7-1.cdninstagram.com/v.mp4', audioUrl: 'https://scontent-lax7-1.cdninstagram.com/a.mp4' };
const mp4 = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
afterEach(() => vi.unstubAllGlobals());
it('fetches both MP4 streams without credentials', async () => {
  const credentials: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => { credentials.push(options.credentials); return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }); });
  const result = await fetchTrackPair(pair, new AbortController().signal);
  expect(result.ok && result.value.video.size).toBe(16); expect(result.ok && result.value.audio?.size).toBe(16);
  expect(credentials).toEqual(['omit', 'omit']);
});
it.each([206, 403])('rejects incomplete/failed status %s', async status => {
  vi.stubGlobal('fetch', async () => new Response(mp4, { status }));
  expect((await fetchTrackPair(pair, new AbortController().signal)).ok).toBe(false);
});
it('bounds streamed bytes even when Content-Length lies', async () => {
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_TRACK_BYTES + 1)); c.close(); } }), { headers: { 'Content-Length': '16' } }));
  expect(await fetchTrackPair(pair, new AbortController().signal)).toEqual({ ok: false, error: 'too-many-items' });
});
it('aborts a pending reader and does not request the next track', async () => {
  const controller = new AbortController(); let reads = 0;
  vi.stubGlobal('fetch', async () => { reads++; return new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort()); } })); });
  expect(await fetchTrackPair(pair, controller.signal)).toEqual({ ok: false, error: 'cancelled' }); expect(reads).toBe(1);
});

