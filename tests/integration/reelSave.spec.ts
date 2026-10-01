import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BlobSource, Input, MP4 } from 'mediabunny';

for (const scenario of ['success', 'cancel', 'navigate', 'spa-away', 'restart'] as const) test(`production Save: ${scenario}`, async ({ playwright }, testInfo) => {
  const extension = resolve('dist');
  const context = await playwright.chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: testInfo.outputPath('downloads'),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let navigations = 0;
  try {
    await context.route('https://www.instagram.com/**', async route => {
      if (route.request().isNavigationRequest()) navigations++;
      await route.fulfill({ contentType: 'text/html', body: await readFile(resolve('tests/fixtures/reel.html')) });
    });
    await context.route('https://scontent-lax7-1.cdninstagram.com/**', async route => {
      const kind = new URL(route.request().url()).pathname === '/v.mp4' ? 'video' : 'audio';
      await route.fulfill({ body: await readFile(resolve(`tests/fixtures/media/${kind}-mse.mp4`)), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'video/mp4' } });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const inspect = await context.newPage();
    await inspect.goto(`chrome-extension://${new URL(worker.url()).host}/library.html`);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('https://www.instagram.com/reel/Fixture/');
    expect(pageErrors).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save Reel' })).toBeVisible();
    expect(await inspect.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(0);
    await page.getByRole('button', { name: 'Save Reel' }).click();
    if (scenario !== 'success') {
      await expect(page.getByRole('status')).toHaveText('Сбор дорожек…');
      if (scenario === 'cancel') {
        await page.getByRole('button', { name: 'Отмена' }).click();
        await expect(page.getByRole('status')).toHaveText('Отменено.');
        expect(await inspect.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(0);
        return;
      }
      if (scenario === 'navigate' || scenario === 'spa-away') {
        if (scenario === 'navigate') await page.goto('https://www.instagram.com/other/');
        else await page.evaluate(() => history.pushState({}, '', '/explore/'));
        await expect.poll(() => inspect.evaluate(() => new Promise<string>((resolve, reject) => {
          const request = indexedDB.open('mediavault');
          request.onerror = () => reject(Error('database'));
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction('operations'), records = tx.objectStore('operations').getAll();
            tx.oncomplete = () => { resolve(records.result[0].state); db.close(); };
          };
        }))).toBe('cancelled');
        expect(await inspect.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(0);
        return;
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      const { targetInfos } = await cdp.send('Target.getTargets');
      const target = targetInfos.find(info => info.type === 'service_worker' && info.url === worker.url())!;
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
      await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(info => info.targetId === target.targetId)).toBe(false);
      await cdp.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${new URL(worker.url()).host}/` });
    }
    await expect(page.getByRole('status')).toHaveText('MP4 сохранён.', { timeout: 15000 });
    expect(navigations).toBe(2);
    const saved = await inspect.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ state: d.state, filename: d.filename })));
    expect(saved).toHaveLength(1); expect(saved[0].state).toBe('complete');
    const input = new Input({ source: new BlobSource(new Blob([await readFile(saved[0].filename)])), formats: [MP4] });
    try { expect(await input.getTracks()).toHaveLength(2); } finally { input.dispose(); }
    const records = await inspect.evaluate(() => new Promise<Record<string, unknown[]>>((resolve, reject) => {
      const request = indexedDB.open('mediavault');
      request.onerror = () => reject(Error('database'));
      request.onsuccess = () => {
        const db = request.result, names = Array.from(db.objectStoreNames), tx = db.transaction(names);
        const reads = names.map(name => [name, tx.objectStore(name).getAll()] as const);
        tx.oncomplete = () => { resolve(Object.fromEntries(reads.map(([name, read]) => [name, read.result]))); db.close(); };
      };
    }));
    expect(records.operations).toHaveLength(1); expect(records.publications).toHaveLength(1);
    expect(JSON.stringify(records)).not.toMatch(/blob:|sig=|blobUrl|videoUrl|audioUrl|cookie/i);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); }
});
