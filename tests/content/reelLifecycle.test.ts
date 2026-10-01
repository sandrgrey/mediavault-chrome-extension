// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createReelLifecycle, type SaveView } from '../../src/content/reelLifecycle';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('reports collection deadline as failure, not as user cancellation', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (message: { type: string }) =>
    message.type === 'reel-claim'
      ? { ok: true, value: { operationId: 'op', token: 'token', deadlineMs: Date.now() + 10 } }
      : { ok: true, value: { state: 'cancelled', safeToRelease: true } } } });
  let view: SaveView | undefined;
  const lifecycle = createReelLifecycle(next => { view = next; });
  await vi.advanceTimersByTimeAsync(11);
  expect(view?.message).toBe('Не удалось подтвердить видео и звук за отведённое время.');
  expect(view?.busy).toBe(false);
  lifecycle.dispose();
});
