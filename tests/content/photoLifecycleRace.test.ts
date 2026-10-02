// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createPhotoLifecycle } from '../../src/content/photoLifecycle';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('cannot start a replacement while cancelled begin is still in flight', async () => {
  vi.useFakeTimers(); vi.stubGlobal('location', { href: 'https://www.instagram.com/p/Fixture/' });
  let begins = 0; const finish: (() => void)[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (m: { type: string }) => {
    if (m.type === 'photo-begin') { begins++; return new Promise(resolve => finish.push(() => resolve({ ok: false, error: 'unavailable' }))); }
    return { ok: true, value: { state: 'cancelled', safeToRelease: true } };
  } } });
  const lifecycle = createPhotoLifecycle(() => {});
  const first = lifecycle.save(); await lifecycle.cancel(); const second = lifecycle.save();
  const actual = begins;
  finish.forEach(resolve => resolve()); await Promise.all([first, second]); lifecycle.dispose();
  expect(actual).toBe(1);
});
