import { test, expect, probe, readProbe, readUserActivation } from './fixtures';
import { saveObservation } from './observations';

const originalUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&hl=en';
// Trace snapshots grant user activation; retain JSON without changing policy.
test.use({ requireActivation: true, trace: 'off' });

test('NotAllowedError и первый локальный play без обратной команды', async ({ page, worker }, testInfo) => {
  test.setTimeout(100_000);
  const observations: Record<string, unknown> = { scenario: 'autoplay', policy: 'document-user-activation-required' };
  try {
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
    // Locator assertions also execute with userGesture=true in Playwright.
    // Until the rejection, inspect only through extension messages/CDP.
    await expect.poll(async () => (await readProbe(worker, page).catch(() => null))?.status, { timeout: 40_000 }).toBe('ready');
    expect(await readUserActivation(page)).toBe(false);
    await probe(worker, page, 'clear');
    expect(await probe(worker, page, 'apply', { positionSeconds: 0, playbackRate: 1, isPlaying: true })).toBe('blocked');
    observations.blocked = await readProbe(worker, page);
    expect((await readProbe(worker, page)).status).toBe('autoplay-blocked');
    expect((await readProbe(worker, page)).traces.some(t => t.event === 'play-rejected' && t.detail === 'NotAllowedError')).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Нажмите play' })).toBeVisible();
    expect((await readProbe(worker, page)).intents).toEqual([]);
    await page.locator('.ytp-play-button').click();
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 20_000 }).toBe('ready');
    await expect.poll(async () => (await readProbe(worker, page)).sample?.isPlaying).toBe(true);
    expect((await readProbe(worker, page)).intents).toEqual([]);
    await page.locator('.ytp-play-button').click();
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['pause']);
    observations.result = 'passed';
  } finally { await saveObservation(page, worker, testInfo, observations); }
});
