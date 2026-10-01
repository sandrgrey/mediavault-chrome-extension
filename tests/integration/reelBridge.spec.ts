import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

test('MAIN bridge captures only when activated and associates the actual MSE player', async ({ playwright }, testInfo) => {
  const dir = testInfo.outputPath('bridge');
  await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    outDir: dir, lib: { entry: resolve('src/media/bridgeMain.ts'), name: 'Bridge', formats: ['iife'], fileName: () => 'bridge.js' },
  } });
  const context = await playwright.chromium.launchPersistentContext('', { channel: 'chromium', headless: true });
  let releaseLongPoll = () => {};
  const longPoll = new Promise<void>(resolve => { releaseLongPoll = resolve; });
  try {
    await context.route('https://fixture.invalid/long-poll', async route => { await longPoll; await route.abort(); });
    await context.route('https://www.instagram.com/**', route => route.fulfill({ contentType: 'text/html', body: '<video muted style="width:300px;height:300px"></video>' }));
    await context.route('https://scontent-lax7-1.cdninstagram.com/**', async route => {
      const name = new URL(route.request().url()).pathname === '/v.mp4' ? 'video' : 'audio';
      await route.fulfill({ body: await readFile(resolve(`tests/fixtures/media/${name}-mse.mp4`)), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'video/mp4' } });
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const native = Response.prototype.clone;
      document.addEventListener('DOMContentLoaded', () => { document.body.dataset.clones = '0'; });
      Response.prototype.clone = function () { document.body.dataset.clones = String(Number(document.body.dataset.clones) + 1); return native.call(this); };
      window.addEventListener('message', e => {
        if (e.data?.type === 'ready' || e.data?.type === 'failed') document.body.dataset.reply = JSON.stringify(e.data);
      });
    });
    await page.addInitScript({ path: resolve(dir, 'bridge.js') });
    await page.goto('https://www.instagram.com/reel/Fixture/');
    const play = () => page.evaluate(async () => {
      const video = document.querySelector('video')!;
      const mse = new MediaSource(); video.src = URL.createObjectURL(mse);
      await new Promise<void>(done => mse.addEventListener('sourceopen', () => done(), { once: true }));
      const tracks = [['v', 'video/mp4; codecs="vp09.00.10.08"'], ['a', 'audio/mp4; codecs="mp4a.40.2"']]
        .map(([path, mime]) => ({ path, source: mse.addSourceBuffer(mime) }));
      for (const { path, source } of tracks) {
        const body = await (await fetch(`https://scontent-lax7-1.cdninstagram.com/${path}.mp4?sig=fixture`)).arrayBuffer();
        source.appendBuffer(body);
        await new Promise<void>((done, reject) => { source.addEventListener('updateend', () => done(), { once: true }); source.addEventListener('error', () => reject(Error('mse-' + path + ':' + video.error?.message)), { once: true }); });
      }
    });
    await play();
    expect(await page.locator('body').getAttribute('data-clones')).toBe('0');
    await page.evaluate(() => window.postMessage({ version: 1, type: 'activate', session: { operationId: 'op', token: 'token', deadlineMs: Date.now() + 10000 } }, location.origin));
    await page.evaluate(() => { void fetch('https://fixture.invalid/long-poll').catch(() => {}); });
    await play();
    await expect.poll(async () => JSON.parse(await page.locator('body').getAttribute('data-reply') ?? '{}')).toMatchObject({
      version: 1, type: 'ready', operationId: 'op', pair: {
        videoUrl: 'https://scontent-lax7-1.cdninstagram.com/v.mp4?sig=fixture',
        audioUrl: 'https://scontent-lax7-1.cdninstagram.com/a.mp4?sig=fixture',
      },
    });
    const captured = await page.locator('body').getAttribute('data-clones');
    await play();
    expect(await page.locator('body').getAttribute('data-clones')).toBe(captured);
    await page.evaluate(() => {
      window.postMessage({ version: 1, type: 'activate', session: { operationId: 'cancel-op', token: 'token', deadlineMs: Date.now() + 10000 } }, location.origin);
      window.postMessage({ version: 1, type: 'cancel', operationId: 'cancel-op' }, location.origin);
    });
    await expect.poll(async () => JSON.parse(await page.locator('body').getAttribute('data-reply') ?? '{}')).toMatchObject({ type: 'failed', operationId: 'cancel-op', error: 'cancelled' });
    await play();
    expect(await page.locator('body').getAttribute('data-clones')).toBe(captured);
    await page.evaluate(() => window.postMessage({ version: 1, type: 'activate', session: { operationId: 'route-op', token: 'token', deadlineMs: Date.now() + 10000 } }, location.origin));
    await page.evaluate(() => history.pushState({}, '', '/reel/Other/'));
    await expect.poll(async () => JSON.parse(await page.locator('body').getAttribute('data-reply') ?? '{}')).toMatchObject({ type: 'failed', operationId: 'route-op', error: 'publication-changed' });
  } finally { releaseLongPoll(); await context.close(); }
});
