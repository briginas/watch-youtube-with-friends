import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/release', testMatch: '**/*.spec.{ts,mjs}',
  outputDir: './.output/release/test-results', workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 20_000 },
  use: { trace: 'off', screenshot: 'off', video: 'off', navigationTimeout: 45_000 },
});
