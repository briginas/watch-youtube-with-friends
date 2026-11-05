import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/room-transport',
  outputDir: './.output/room-transport/test-results',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Ответы с UID/данными комнаты не записываем в trace.
  use: { trace: 'off' },
});
