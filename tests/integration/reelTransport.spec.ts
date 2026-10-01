import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { build } from 'vite';
import { BlobSource, Input, MP4 } from 'mediabunny';
import { startFixtureServer } from './fixtureServer';

for (const closeBeforeDownload of [false, true]) test(`isolated remux Blob transport; creator closes before download: ${closeBeforeDownload}`, async ({ playwright }, testInfo) => {
  const server = await startFixtureServer();
  const extension = testInfo.outputPath('extension');
  await mkdir(extension, { recursive: true });
  await cp(resolve('tests/fixtures/transport/manifest.json'), resolve(extension, 'manifest.json'));
  await cp(resolve('tests/fixtures/transport/worker.js'), resolve(extension, 'worker.js'));
  await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    outDir: extension, emptyOutDir: false, lib: { entry: resolve('tests/fixtures/transport/content.js'), name: 'Transport', formats: ['iife'], fileName: () => 'content.js' },
  } });
  const context = await playwright.chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: testInfo.outputPath('downloads'),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 5000 });
    await context.addCookies([{ name: 'fixture_cookie', value: 'must-not-be-sent', url: server.mediaOrigin }]);
    const page = await context.newPage();
    await page.goto(server.pageOrigin);
    expect(server.requests).toHaveLength(0);
    if (closeBeforeDownload) await page.evaluate(() => { document.body.dataset.closeBeforeDownload = 'true'; });
    await page.getByRole('button', { name: 'Save fixture' }).click();
    if (closeBeforeDownload) {
      await expect(page.locator('#status')).toHaveText('ready');
      const blob = await page.evaluate(() => document.body.dataset.blob!);
      await page.close();
      const completed = await worker.evaluate(async url => {
        try {
          const id = await chrome.downloads.download({ url, filename: 'MediaVault/closed.mp4' });
          for (let attempt = 0; attempt < 30; attempt++) {
            const [item] = await chrome.downloads.search({ id });
            if (item?.state !== 'in_progress') return item?.state === 'complete';
            await new Promise(done => setTimeout(done, 50));
          }
          return false;
        } catch { return false; }
      }, blob);
      expect(completed).toBe(false);
      return;
    }
    await expect(page.locator('#status')).toHaveText('complete; released', { timeout: 10_000 });
    const saved = await worker.evaluate(async () => (await chrome.downloads.search({})).map(item => ({ state: item.state, filename: item.filename })));
    expect(saved).toHaveLength(1);
    expect(saved[0].state).toBe('complete');
    expect(server.requests.map(request => request.path).sort()).toEqual(['/audio.mp4', '/video.mp4']);
    expect(server.requests.every(request => request.cookie === undefined && request.origin === server.pageOrigin)).toBe(true);
    const input = new Input({ source: new BlobSource(new Blob([await readFile(saved[0].filename)])), formats: [MP4] });
    try {
      expect(await (await input.getPrimaryVideoTrack())?.getCodec()).toBe('vp9');
      expect(await (await input.getPrimaryAudioTrack())?.getCodec()).toBe('aac');
    } finally { input.dispose(); }
  } finally { await context.close(); await server.close(); }
});
