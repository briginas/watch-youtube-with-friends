import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/cloud',
  testMatch: '**/*.spec.ts',
  outputDir: './.output/cloud/test-results',
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  use: { trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 },
});
