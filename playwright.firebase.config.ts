import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/firebase-context',
  outputDir: './.output/firebase-context/test-results',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { trace: 'retain-on-failure' },
});
