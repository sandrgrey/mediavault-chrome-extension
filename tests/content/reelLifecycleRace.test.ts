// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createReelLifecycle } from '../../src/content/reelLifecycle';
import { fetchTrackPair } from '../../src/media/trackFetch';
import { remuxTracks, type RemuxResult } from '../../src/media/remux';
vi.mock('../../src/media/trackFetch', () => ({ fetchTrackPair: vi.fn() }));
vi.mock('../../src/media/remux', () => ({ remuxTracks: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.innerHTML = ''; });
it('does not submit if the pinned player changes during remux before the next monitor tick', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { href: 'https://www.instagram.com/reel/Ab/', origin: 'https://www.instagram.com' });
  const RealURL = URL;
  vi.stubGlobal('URL', class extends RealURL {
    static createObjectURL() { return 'blob:https://www.instagram.com/12345678-abcd-1234-abcd-123456789abc'; }
    static revokeObjectURL() {}
  });
  const messages: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (message: { type: string }) => {
    messages.push(message.type);
    return message.type === 'reel-claim'
      ? { ok: true, value: { operationId: 'op', token: 'token', deadlineMs: Date.now() + 10000 } }
      : { ok: true, value: { state: message.type === 'reel-submit' ? 'completed' : 'cancelled', safeToRelease: true } };
  } } });
  const video = document.createElement('video'); document.body.append(video);
  let source = 'blob:https://www.instagram.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  Object.defineProperty(video, 'currentSrc', { get: () => source });
  video.getBoundingClientRect = () => new DOMRect(0, 0, 200, 200);
  vi.mocked(fetchTrackPair).mockResolvedValue({ ok: true, value: { video: new Blob(['v']), audio: new Blob(['a']) } });
  let finish!: (value: RemuxResult) => void;
  vi.mocked(remuxTracks).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const lifecycle = createReelLifecycle(() => {});
  await vi.advanceTimersByTimeAsync(301);
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: {
    version: 1, type: 'ready', operationId: 'op', token: 'token',
    playerSrc: source,
    pair: { videoUrl: 'https://scontent-lax7-1.cdninstagram.com/v.mp4', audioUrl: 'https://scontent-lax7-1.cdninstagram.com/a.mp4' },
  } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(remuxTracks).toHaveBeenCalledTimes(1);
  source = 'blob:https://www.instagram.com/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  finish({ ok: true, value: new Blob(['mp4']) });
  await vi.advanceTimersByTimeAsync(0);
  expect(messages).not.toContain('reel-submit');
  expect(messages).toContain('reel-cancel');
  lifecycle.dispose();
});
