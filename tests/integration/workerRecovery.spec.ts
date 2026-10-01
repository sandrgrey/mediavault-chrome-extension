import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { operation } from '../helpers/domain';

test('worker restart reconciles real Chrome completion and retains ambiguous dispatch without replay', async ({ playwright }, testInfo) => {
  const extension = resolve('dist');
  const context = await playwright.chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: testInfo.outputPath('downloads'),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const origin = new URL(worker.url()).origin;
    // URL.origin is "null" for non-special schemes in Node; preserve the extension host.
    const base = origin === 'null' ? `chrome-extension://${new URL(worker.url()).host}` : origin;
    const page = await context.newPage();
    await page.goto(`${base}/library.html`);
    const id = await page.evaluate(async () => {
      const url = URL.createObjectURL(new Blob(['synthetic recovery fixture']));
      return chrome.downloads.download({ url, filename: 'MediaVault/recovery-fixture.txt', conflictAction: 'uniquify' });
    });
    await expect.poll(() => page.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0]?.state, id)).toBe('complete');
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(info => info.type === 'service_worker' && info.url === worker.url());
    expect(target).toBeDefined();
    await cdp.send('Target.closeTarget', { targetId: target!.targetId });
    await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(info => info.targetId === target!.targetId)).toBe(false);
    const op = operation();
    op.items = op.items.map((item, index) => ({ ...item, status: index === 0 ? 'downloading' : index === 1 ? 'dispatching' : 'pending',
      downloadId: index === 0 ? id : null, errorCode: null }));
    // Seed the durable journal at a crash boundary, never a test hook in production.
    await page.evaluate(record => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('mediavault');
      request.onupgradeneeded = () => {
        const db = request.result;
        const publications = db.createObjectStore('publications', { keyPath: 'id' });
        publications.createIndex('sourceIdentity', 'sourceIdentity'); publications.createIndex('savedAt', 'savedAt');
        const operations = db.createObjectStore('operations', { keyPath: 'id' });
        operations.createIndex('requestId', 'requestId', { unique: true });
        operations.createIndex('publicationId', 'publicationId'); operations.createIndex('state', 'state');
        db.createObjectStore('activePublications', { keyPath: 'publicationId' });
        db.createObjectStore('sourceIntents', { keyPath: 'tabId' }).createIndex('publicationId', 'publicationId');
      };
      request.onerror = () => reject(Error('db-open-failed'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['operations', 'activePublications'], 'readwrite');
        tx.objectStore('operations').put(record);
        tx.objectStore('activePublications').put({ publicationId: record.publicationId, operationId: record.id });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(Error('seed-failed')); };
      };
    }), op);
    
    await cdp.send('ServiceWorker.startWorker', { scopeURL: `${base}/` });
    await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(info => info.type === 'service_worker' && info.url === worker.url())).toBe(true);
    
    const read = () => page.evaluate(() => new Promise<{ state: string; statuses: string[]; saved: number }>((resolve, reject) => {
      const request = indexedDB.open('mediavault');
      request.onerror = () => reject(Error('db-open-failed'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['operations', 'publications']);
        const ops = tx.objectStore('operations').get('operation-1');
        const publications = tx.objectStore('publications').getAll();
        tx.oncomplete = () => {
          resolve({ state: ops.result.state, statuses: ops.result.items.map((item: { status: string }) => item.status), saved: publications.result.length });
          db.close();
        };
      };
    }));
    await expect.poll(read).toEqual({ state: 'uncertain', statuses: ['completed', 'uncertain', 'pending'], saved: 1 });
    expect(await page.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(1);
  } finally { await context.close(); }
});
