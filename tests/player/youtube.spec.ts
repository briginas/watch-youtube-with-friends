import { test, expect, probe, readProbe, type ProbeReport } from './fixtures';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Explicit opt-in: depends on the live site, network, region and YouTube experiments.
test('реальный YouTube: контролы, клавиатура, удалённое применение и buffering', async ({ page, worker, context }, testInfo) => {
  test.setTimeout(150_000);
  const observations: Record<string, unknown> = {};
  const checkpoints: Record<string, ProbeReport> = {};
  const mediaFailures: { host: string; error: string | number }[] = [];
  page.on('requestfailed', request => {
    const host = new URL(request.url()).hostname;
    if (host.endsWith('.googlevideo.com')) mediaFailures.push({ host, error: request.failure()?.errorText ?? 'unknown' });
  });
  page.on('response', response => {
    const host = new URL(response.url()).hostname;
    if (host.endsWith('.googlevideo.com') && response.status() >= 400) mediaFailures.push({ host, error: response.status() });
  });
  async function checkpoint(name: string) { checkpoints[name] = await readProbe(worker, page); }
  try {
    await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ&hl=en', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 30_000 });
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 40_000 }).toBe('ready');
    await checkpoint('initial');
    const target = { positionSeconds: 10, playbackRate: 1, isPlaying: false };
    expect(await probe(worker, page, 'apply', target)).toBe('applied');
    await probe(worker, page, 'clear');
    await page.locator('.ytp-play-button').click();
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play']);
    await page.locator('.ytp-play-button').click();
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play', 'pause']);
    await checkpoint('buttons');
    await probe(worker, page, 'clear');
    await page.locator('#movie_player').focus();
    await page.keyboard.press('k');
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play']);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play', 'pause']);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.kind).toBe('seek');
    await checkpoint('keyboard');
    await probe(worker, page, 'clear');
    const bar = page.locator('.ytp-progress-bar').first();
    const bounds = await bar.boundingBox();
    if (!bounds) throw new Error('YouTube seek bar missing');
    const duration = await page.locator('#movie_player video').evaluate(v => (v as HTMLVideoElement).duration);
    // Keep the controls matrix in the initially buffered range. Distant delivery is tested below.
    await bar.click({ position: { x: bounds.width * 12 / duration, y: 5 } });
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['seek']);
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 20_000 }).toBe('ready');
    await checkpoint('seek');
    await probe(worker, page, 'clear');
    await page.locator('.ytp-settings-button').click();
    await page.locator('.ytp-menuitem').filter({ hasText: 'Playback speed' }).click();
    await page.locator('.ytp-variable-speed-panel-preset-button').filter({ hasText: /^1\.5$/ }).click();
    await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.sample.playbackRate).toBe(1.5);
    await checkpoint('rate-menu');
    await page.keyboard.press('Escape');
    await page.locator('#movie_player').focus();
    await page.keyboard.press('Shift+Period');
    await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.sample.playbackRate).toBe(1.75);
    await checkpoint('rate-keyboard');
    await probe(worker, page, 'clear');
    expect(await probe(worker, page, 'apply', { positionSeconds: 10, playbackRate: 1.25, isPlaying: true })).toBe('applied');
    await checkpoint('remote-play');
    expect(checkpoints['remote-play']!.intents).toEqual([]);
    expect(await probe(worker, page, 'apply', { positionSeconds: 11, playbackRate: 1, isPlaying: false })).toBe('applied');
    await checkpoint('remote-pause');
    expect(checkpoints['remote-pause']!.intents).toEqual([]);

    // A real media load failure induced by network loss, not a synthetic waiting event.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    try {
      await page.evaluate(() => { const v = document.querySelector<HTMLVideoElement>('#movie_player video')!; v.currentTime = v.duration * 0.87; });
      await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 15_000 }).toBe('buffering');
      await checkpoint('network-buffering');
      expect(checkpoints['network-buffering']!.intents).toEqual([]);
      expect(await probe(worker, page, 'apply', target)).toBe('blocked');
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
    }
    // Return to cached media explicitly: this environment may not deliver a distant range
    // even with the network restored. Do not present that as recovered remote delivery.
    await page.evaluate(() => { document.querySelector<HTMLVideoElement>('#movie_player video')!.currentTime = 10; });
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 25_000 }).toBe('ready');
    await checkpoint('network-restored');
    expect(checkpoints['network-restored']!.intents).toEqual([]);
    observations.controls = 'passed';
    observations.bufferingRecovery = 'network restored, local seek back to cached 10s';
    // Natural ads are observed only; never injected, skipped, or bypassed by this test.
    observations.adObserved = Object.values(checkpoints).some(r => r.traces.some(t => t.status === 'ad'));
    observations.playerReplacement = 'tested on controlled fixture, not forced on live YouTube';
  } finally {
    observations.url = page.url();
    observations.mediaFailures = mediaFailures;
    observations.title = await page.title().catch(() => 'unavailable');
    observations.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => 'unavailable');
    observations.media = await page.locator('#movie_player video').first().evaluate((element) => {
      const v = element as HTMLVideoElement;
      return { readyState: v.readyState, networkState: v.networkState, duration: v.duration,
        position: v.currentTime, error: v.error?.message, paused: v.paused,
        class: document.querySelector('#movie_player')?.className };
    }).catch(() => 'unavailable');
    await checkpoint('final').catch(() => {});
    const output = testInfo.outputPath('youtube-observations.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ observations, checkpoints }, null, 2));
    await testInfo.attach('youtube-observations.json', { path: output, contentType: 'application/json' });
  }
});

test('естественная реклама: применение заблокировано, системные события локальны', async ({ page, worker }, testInfo) => {
  test.setTimeout(150_000);
  const attempts: { videoId: string; adObserved: boolean; status: string }[] = [];
  let verified = false;
  try {
    for (const videoId of ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', '9bZkp7q19f0']) {
      await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#watch-together-player-probe')).toBeAttached({ timeout: 20_000 });
      const started = Date.now();
      let report = await readProbe(worker, page);
      while (Date.now() - started < 10_000 && report.status !== 'ad') {
        await page.waitForTimeout(250);
        report = await readProbe(worker, page);
      }
      attempts.push({ videoId, adObserved: report.traces.some(t => t.status === 'ad'), status: report.status });
      if (report.status !== 'ad') continue;
      expect(await probe(worker, page, 'apply', { positionSeconds: 10, playbackRate: 1, isPlaying: true })).toBe('blocked');
      expect(report.intents).toEqual([]);
      await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 70_000 }).toBe('ready');
      expect((await readProbe(worker, page)).intents).toEqual([]);
      verified = true;
      break;
    }
  } finally {
    const output = testInfo.outputPath('youtube-ad-observations.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ verified, attempts }, null, 2));
    await testInfo.attach('youtube-ad-observations.json', { path: output, contentType: 'application/json' });
  }
  test.skip(!verified, 'Естественная реклама не появилась в ограниченной выборке; это не подтверждение ad-сценария.');
});
