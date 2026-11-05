import { test, expect, probe, readProbe } from './fixtures';
import { saveObservation } from './observations';

const originalVideoId = 'aqz-KE-bpKQ';
const originalUrl = `https://www.youtube.com/watch?v=${originalVideoId}&hl=en`;

test('реальный YouTube: недоступный ролик показывает локальную ошибку', async ({ page, worker }, testInfo) => {
  test.setTimeout(70_000);
  const observations: Record<string, unknown> = { scenario: 'unavailable' };
  try {
    await page.goto('https://www.youtube.com/watch?v=00000000000&hl=en', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 25_000 });
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 25_000 }).toBe('unavailable');
    await expect(page.getByRole('status').filter({ hasText: 'Видео недоступно' })).toBeVisible();
    expect(await probe(worker, page, 'apply', { positionSeconds: 0, playbackRate: 1, isPlaying: true })).toBe('blocked');
    expect((await readProbe(worker, page)).intents).toEqual([]);
    observations.result = 'passed';
  } finally { await saveObservation(page, worker, testInfo, observations); }
});

test('реальный YouTube: SPA по ссылке на другой ролик и возврат', async ({ page, worker }, testInfo) => {
  test.setTimeout(130_000);
  const observations: Record<string, unknown> = { scenario: 'spa' };
  try {
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 25_000 });
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 40_000 }).toBe('ready');
    expect(await probe(worker, page, 'apply', { positionSeconds: 0, playbackRate: 1, isPlaying: false })).toBe('applied');
    await probe(worker, page, 'clear');
    const marker = await page.evaluate(() => {
      const value = crypto.randomUUID();
      document.documentElement.dataset.lifecycleDocument = value;
      document.querySelector('#movie_player')!.setAttribute('data-lifecycle-root', value);
      document.querySelector('#movie_player video')!.setAttribute('data-lifecycle-video', value);
      return value;
    });
    const link = page.locator(`a[href^="/watch?v="]:not([href*="${originalVideoId}"]):visible`).first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    const href = await link.getAttribute('href');
    const nextVideoId = new URL(href!, originalUrl).searchParams.get('v');
    observations.nextVideoId = nextVideoId;
    await link.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe(nextVideoId);
    expect(await page.evaluate(() => document.documentElement.dataset.lifecycleDocument)).toBe(marker);
    await expect.poll(async () => (await readProbe(worker, page)).status).toBe('different-video');
    await expect(page.getByRole('status').filter({ hasText: 'Не синхронизируется' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Вернуться в комнату' })).toHaveAttribute('href', `https://www.youtube.com/watch?v=${originalVideoId}`);
    // Wait for the site's own navigation completion, without replacing any DOM or media API.
    await expect.poll(() => page.locator('#movie_player video').evaluate(v => (v as HTMLVideoElement).readyState), { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
    observations.afterNavigation = await readProbe(worker, page);
    observations.binding = await page.evaluate(() => ({
      rootMarker: document.querySelector('#movie_player')?.getAttribute('data-lifecycle-root'),
      videoMarker: document.querySelector('#movie_player video')?.getAttribute('data-lifecycle-video'),
    }));
    expect(await probe(worker, page, 'apply', { positionSeconds: 10, playbackRate: 1.25, isPlaying: false })).toBe('blocked');
    expect((await readProbe(worker, page)).intents).toEqual([]);
    // Exercise browser Back in the same document, then the visible return action.
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe(originalVideoId);
    expect(await page.evaluate(() => document.documentElement.dataset.lifecycleDocument)).toBe(marker);
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 30_000 }).toBe('ready');
    expect((await readProbe(worker, page)).intents).toEqual([]);
    await page.goForward();
    await expect.poll(async () => (await readProbe(worker, page)).status).toBe('different-video');
    await page.getByRole('link', { name: 'Вернуться в комнату' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe(originalVideoId);
    await expect.poll(async () => (await readProbe(worker, page).catch(() => null))?.status, { timeout: 30_000 }).toBe('ready');
    expect((await readProbe(worker, page)).intents).toEqual([]);
    observations.result = 'passed';
  } finally { await saveObservation(page, worker, testInfo, observations); }
});
