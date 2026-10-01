import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { BlobSource, Input, MP4 } from 'mediabunny';

test('bundled extension merges local tracks and completes a real MP4 download', async ({ playwright }, testInfo) => {
  const extension = resolve('dist');
  const downloadsPath = testInfo.outputPath('downloads');
  await mkdir(downloadsPath, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/merge.html`);
    await expect(page.getByRole('heading', { name: 'Объединить видео и звук' })).toBeVisible();
    await page.getByLabel('Видеодорожка').setInputFiles({ name: 'bad.mp4', mimeType: 'video/mp4', buffer: Buffer.from('INVALID') });
    await page.getByLabel('Аудиодорожка').setInputFiles(resolve('tests/fixtures/media/audio.mp4'));
    await page.getByRole('button', { name: 'Объединить и сохранить' }).click();
    await expect(page.getByRole('alert')).toContainText('Не удалось прочитать');
    expect(await worker.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(0);
    await page.getByLabel('Видеодорожка').setInputFiles(resolve('tests/fixtures/media/video.mp4'));
    await page.getByRole('button', { name: 'Объединить и сохранить' }).click();
    await expect(page.getByRole('status')).toHaveText('MP4 сохранён.');
    const saved = await worker.evaluate(async () => (await chrome.downloads.search({})).map(item => ({ state: item.state, filename: item.filename })));
    expect(saved).toHaveLength(1);
    expect(saved[0].state).toBe('complete');
    const input = new Input({ source: new BlobSource(new Blob([await readFile(saved[0].filename)])), formats: [MP4] });
    try {
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      expect(await video?.getCodec()).toBe('vp9');
      expect(await audio?.getCodec()).toBe('aac');
      expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
    } finally { input.dispose(); }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
