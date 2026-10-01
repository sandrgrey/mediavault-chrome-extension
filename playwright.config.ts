import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: { headless: true, trace: 'off' },
});
