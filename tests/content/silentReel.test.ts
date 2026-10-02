// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { isExplicitlySilent } from '../../src/providers/instagram/silentReel';
afterEach(() => { document.body.innerHTML = ''; });
it('binds the visible no-audio label to a container with only the current video', () => {
  document.body.innerHTML = '<section><video></video><svg aria-label="В видео нет звука"></svg></section>';
  const video = document.querySelector('video')!;
  const marker = document.querySelector('svg')!;
  marker.getBoundingClientRect = () => ({ width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 }) as DOMRect;
  expect(isExplicitlySilent(video)).toBe(true);
  const hidden = document.createElement('div'); hidden.style.opacity = '0';
  marker.replaceWith(hidden); hidden.append(marker);
  expect(isExplicitlySilent(video)).toBe(false);
  hidden.style.opacity = '1';
  marker.setAttribute('aria-label', 'Audio is muted');
  expect(isExplicitlySilent(video)).toBe(false);
  marker.setAttribute('aria-label', 'В видео нет звука');
  document.querySelector('section')!.append(document.createElement('video'));
  expect(isExplicitlySilent(video)).toBe(false);
});
it('rejects hidden and unrelated markers and missing evidence', () => {
  document.body.innerHTML = '<section><video></video></section><aside><svg aria-label="В видео нет звука"></svg></aside>';
  const video = document.querySelector('video')!;
  expect(isExplicitlySilent(video)).toBe(false);
  video.parentElement!.append(document.querySelector('svg')!);
  expect(isExplicitlySilent(video)).toBe(false);
});
