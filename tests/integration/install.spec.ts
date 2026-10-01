import { chromium, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('loads the unpacked extension and opens its library without page errors', async () => {
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(page.getByRole('heading', { name: 'MediaVault', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
