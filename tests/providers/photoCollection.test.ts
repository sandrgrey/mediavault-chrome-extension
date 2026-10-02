// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { collectPhotos } from '../../src/providers/instagram/photos';
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });
function fixture(total: number, start = 0) {
  let index = start;
  const address = () => new URL(`https://www.instagram.com/p/Fixture/?img_index=${index + 1}`);
  document.body.innerHTML = '<section><div style="overflow-x:auto"><ul><li style="width:1px"></li><li><img></li></ul></div><button aria-label="Назад"></button><button aria-label="Далее"></button></section>';
  const list = document.querySelector('ul')!, image = document.querySelector('img')!, slide = image.parentElement!;
  const back = document.querySelector<HTMLButtonElement>('button')!, next = document.querySelectorAll<HTMLButtonElement>('button')[1];
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 400 }, complete: { value: true }, currentSrc: { get: () => `https://scontent-lax3-2.cdninstagram.com/photo${index}.jpg` } });
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200 } as DOMRect;
  image.getBoundingClientRect = () => rect; slide.getBoundingClientRect = () => rect; list.getBoundingClientRect = () => rect;
  list.parentElement!.getBoundingClientRect = () => rect;
  (list.firstElementChild as HTMLElement).style.transform = `translateX(${total * 300 - 1}px)`;
  const render = () => { slide.style.transform = `translateX(${index * 300}px)`; back.hidden = index === 0; next.hidden = index === total - 1; };
  back.onclick = () => { index--; render(); }; next.onclick = () => { index++; render(); }; render();
  return { address, next, image, list };
}
it('returns to the start and collects all four photos in order', async () => {
  const f = fixture(4, 2);
  const result = await collectPhotos({ document, location: f.address, signal: new AbortController().signal, onProgress: () => {} });
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error);
  expect(result.value.items.map(i => i.index)).toEqual([0, 1, 2, 3]);
  expect(result.value.items.map(i => i.downloadUrl)).toEqual([0, 1, 2, 3].map(i => `https://scontent-lax3-2.cdninstagram.com/photo${i}.jpg`));
  expect(result.value.collectionStatus).toBe('complete');
  expect(result.value.items.every(i => i.stableItemId === null)).toBe(true);
});
it('refuses to call a missing Next the end when the observed total is larger', async () => {
  vi.useFakeTimers(); const f = fixture(4); f.next.hidden = true;
  const pending = collectPhotos({ document, location: f.address, signal: new AbortController().signal, onProgress: () => {} });
  await vi.advanceTimersByTimeAsync(11000);
  const result = await pending;
  expect(result.ok && result.value.collectionStatus).toBe('partial');
});
it('cancellation does not return a downloadable partial result', async () => {
  const f = fixture(4); const controller = new AbortController(); controller.abort();
  expect(await collectPhotos({ document, location: f.address, signal: controller.signal, onProgress: () => {} })).toEqual({ ok: false, error: 'cancelled' });
});
