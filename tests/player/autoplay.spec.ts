import { test, expect, openFixture, probe, readProbe, readUserActivation } from './fixtures';

// DOM snapshots grant user activation; preserve the browser policy under test.
test.use({ requireActivation: true, trace: 'off' });

test('NotAllowedError, подсказка и первый локальный play без общей команды', async ({ page, worker }) => {
  await openFixture(page, worker, { userActivation: false });
  expect(await readUserActivation(page)).toBe(false);
  expect(await probe(worker, page, 'apply', { positionSeconds: 0, playbackRate: 1, isPlaying: true })).toBe('blocked');
  const report = await readProbe(worker, page);
  expect(report.status).toBe('autoplay-blocked');
  expect(report.traces.some(t => t.event === 'play-rejected' && t.detail === 'NotAllowedError')).toBe(true);
  expect(report.intents).toEqual([]);
  await expect(page.getByRole('status')).toContainText('Нажмите play');
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['pause']);
});
