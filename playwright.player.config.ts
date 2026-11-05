import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/player',
  testMatch: process.env.YOUTUBE_DELIVERY_REAL === '1' ? ['**/youtube-delivery.spec.ts'] : process.env.YOUTUBE_PLAYER_REAL === '1'
    ? ['**/youtube.spec.ts', '**/youtube-rate.spec.ts', '**/lifecycle.spec.ts', '**/youtube-autoplay.spec.ts']
    : ['**/adapter.spec.ts', '**/autoplay.spec.ts'],
  outputDir: process.env.YOUTUBE_PLAYER_REAL === '1' || process.env.YOUTUBE_DELIVERY_REAL === '1' ? '.output/youtube-player/live-results' : '.output/youtube-player/test-results',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
});
