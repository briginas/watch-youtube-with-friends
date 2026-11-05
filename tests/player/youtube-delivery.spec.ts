import { test, expect, probe, readProbe } from './fixtures';
import { saveObservation } from './observations';

test.use({ trace: 'off' });
test.setTimeout(120_000);

test('YouTube: реальная ошибка доставки без MediaError и восстановление адаптера после reload', async ({ page, worker }, testInfo) => {
  test.skip(process.env.YOUTUBE_DELIVERY_REAL !== '1', 'Opt-in: воспроизведение внешнего сбоя доставки YouTube.');
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ&hl=en', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 25_000 });
  await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 45_000 }).toBe('ready');
  await page.locator('video.html5-main-video').first().evaluate((video: HTMLVideoElement) => {
    video.pause(); video.currentTime = 45;
  });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await probe(worker, page, 'clear');
  await page.locator('#movie_player').focus();
  await page.keyboard.press('k');
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(intent => intent.kind)).toEqual(['play']);
  await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 45_000 }).toBe('unavailable');
  const failed = await readProbe(worker, page);
  expect(failed.intents.map(intent => intent.kind)).toEqual(['play']);
  const media = await page.locator('video.html5-main-video').first().evaluate((video: HTMLVideoElement) => ({
    readyState: video.readyState, error: video.error?.code ?? null,
  }));
  expect(media).toEqual({ readyState: 0, error: null });
  expect(await probe(worker, page, 'apply', { positionSeconds: 10, playbackRate: 1, isPlaying: false })).toBe('blocked');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 25_000 });
  await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 45_000 }).toBe('ready');
  expect(await probe(worker, page, 'apply', { positionSeconds: 10, playbackRate: 1, isPlaying: false })).toBe('applied');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await saveObservation(page, worker, testInfo, { externalDeliveryError: media, failed,
    recovered: true, roomTransport: false, note: 'Native YouTube media; no fake media/error events. Reproduction is environment-dependent.' });
});
