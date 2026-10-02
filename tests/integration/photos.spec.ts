import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
for (const mode of ['photo', 'carousel', 'cancel'] as const) test(`photo Save: ${mode}`, async ({ playwright }, info) => {
  const extension = resolve('dist');
  const context = await playwright.chromium.launchPersistentContext('', { channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: info.outputPath('downloads'), args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const fixture = await readFile('tests/fixtures/photos.html', 'utf8'), bytes = await readFile('tests/fixtures/media/photo.png');
    await context.route('https://www.instagram.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: mode === 'photo' ? '<img width="300" height="200" src="https://scontent-lax3-2.cdninstagram.com/photo0.png">' : fixture }));
    await context.route('https://scontent-lax3-2.cdninstagram.com/**', route => route.fulfill({ body: bytes, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto('https://www.instagram.com/p/Fixture/');
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByRole('button', { name: 'Save фото' })).toBeEnabled();
    await page.getByRole('button', { name: 'Save фото' }).click();
    if (mode === 'cancel') { await page.getByRole('button', { name: 'Отмена' }).click(); await expect(page.getByRole('status')).toHaveText('Отменено.'); }
    else await expect(page.getByRole('status')).toHaveText('Фото сохранены.', { timeout: 15000 });
    const saved = await worker.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ state: d.state, filename: d.filename })));
    expect(saved).toHaveLength(mode === 'cancel' ? 0 : mode === 'photo' ? 1 : 4);
    for (const file of saved) { expect(file.state).toBe('complete'); expect(await readFile(file.filename)).toEqual(bytes); }
    const operations = await worker.evaluate(() => new Promise<{ items: { filename: string }[] }[]>((resolve, reject) => {
      const request = indexedDB.open('mediavault'); request.onerror = () => reject(Error('database'));
      request.onsuccess = () => { const db = request.result, tx = db.transaction('operations'), read = tx.objectStore('operations').getAll(); tx.oncomplete = () => { resolve(read.result); db.close(); }; };
    }));
    if (mode === 'carousel') expect(operations[0].items.map(d => d.filename.match(/\d\d-image\.png/)?.[0])).toEqual(['01-image.png', '02-image.png', '03-image.png', '04-image.png']);
    expect(JSON.stringify(operations)).not.toMatch(/blob:|cdninstagram|downloadUrl/);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('result.png') });
  } finally { await context.close(); }
});
