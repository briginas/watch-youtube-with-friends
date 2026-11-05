import { test, expect, probe, readProbe } from './fixtures';
import { saveObservation } from './observations';
import { russianRateShortcut } from '../keyboard';

test('реальный YouTube: удалённая скорость, меню и первое > согласованы', async ({ page, worker }, testInfo) => {
  test.setTimeout(100_000);
  const observations: Record<string, unknown> = { scenario: 'remote-rate-native-ui' };
  try {
    await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ&hl=en', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 30_000 });
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 40_000 }).toBe('ready');
    // Enter paused at a cached position to isolate rate handling from long media delivery.
    expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate: 1, isPlaying: false })).toBe('applied');
    await probe(worker, page, 'clear');
    for (const playbackRate of [1.25, 1.5, 1]) {
      expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate, isPlaying: false })).toBe('applied');
      await page.locator('.ytp-settings-button').click();
      const speedMenu = page.locator('.ytp-menuitem').filter({ hasText: 'Playback speed' });
      await expect(speedMenu).toContainText(playbackRate === 1 ? 'Normal' : String(playbackRate));
      await expect.poll(async () => page.locator('#movie_player').evaluate(root =>
        (root as HTMLElement & { getPlaybackRate: () => number }).getPlaybackRate())).toBe(playbackRate);
      expect((await readProbe(worker, page)).sample?.playbackRate).toBe(playbackRate);
      expect((await readProbe(worker, page)).intents).toEqual([]);
      observations[`remote-${playbackRate}`] = { menu: await speedMenu.textContent(), report: await readProbe(worker, page) };
      await page.keyboard.press('Escape');
    }
    expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate: 1.25, isPlaying: false })).toBe('applied');
    await page.locator('#movie_player').focus();
    await page.keyboard.press('Shift+Period');
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => ({ kind: i.kind, rate: i.sample.playbackRate })))
      .toEqual([{ kind: 'rate', rate: 1.5 }]);
    await page.waitForTimeout(500);
    expect((await readProbe(worker, page)).intents).toHaveLength(1);
    observations.firstKey = await readProbe(worker, page);
    for (const direction of ['down', 'up'] as const) {
      await russianRateShortcut(page, direction);
      await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => ({ kind: i.kind, rate: i.sample.playbackRate })))
        .toEqual(direction === 'down'
          ? [{ kind: 'rate', rate: 1.5 }, { kind: 'rate', rate: 1.25 }]
          : [{ kind: 'rate', rate: 1.5 }, { kind: 'rate', rate: 1.25 }, { kind: 'rate', rate: 1.5 }]);
    }
    await page.waitForTimeout(500);
    expect((await readProbe(worker, page)).intents).toHaveLength(3);
    observations.russianKeys = await readProbe(worker, page);
    observations.result = 'passed';
  } finally { await saveObservation(page, worker, testInfo, observations); }
});
