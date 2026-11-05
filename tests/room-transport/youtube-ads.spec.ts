import { test, expect } from '@playwright/test';
import { frameOf } from './fixtures';
import { converged, livePair, seek } from './youtube-matrix-fixture';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
test.use({ trace: 'off' });

for (const videoId of ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', '9bZkp7q19f0']) {
  test(`YouTube matrix: естественная реклама у гостя (${videoId})`, async ({}, testInfo) => {
    test.setTimeout(210_000);
    let observed = false;
    await livePair(testInfo, async ({ record }) => {
      await record('natural ad observation', { videoId, adObserved: observed });
    }, undefined, { videoId, headless: false, async inspectGuest(a, b, room) {
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        observed = await b.locator('#movie_player').evaluate(root => root.matches('.ad-showing, .ad-interrupting')).catch(() => false);
        if (observed) break;
        await b.waitForTimeout(100);
      }
      if (!observed) return { name: 'no natural ad in observation window', videoId, adObserved: false, windowMs: 20_000 };
      const session = await frameOf(b);
      await expect(session.locator('#player-status')).toContainText('Реклама');
      const before = (await room()).playback;
      await b.waitForTimeout(500);
      expect((await room()).playback).toEqual(before);
      await seek(a, 'ArrowRight');
      await expect.poll(async () => (await room()).playback.revision).toBe(before.revision + 1);
      const latest = (await room()).playback;
      // Никаких skip-ad, смены DOM, media API или запросов обхода рекламы.
      await expect.poll(() => b.locator('#movie_player').evaluate(root => root.matches('.ad-showing, .ad-interrupting')),
        { timeout: 90_000 }).toBe(false);
      await converged(a, b, latest);
      await b.waitForTimeout(1800);
      expect((await room()).playback).toEqual(latest);
      return { name: 'natural ad local, latest state restored without echo', videoId, adObserved: true, revision: latest.revision };
    } });
    test.skip(!observed, 'Естественная реклама не появилась; ad-сценарий не подтверждён.');
  });
}
