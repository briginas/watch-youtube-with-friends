import { test, expect } from '@playwright/test';
import { readyPlayer, sample } from './playback-fixture';
import { converged, livePair, seek } from './youtube-matrix-fixture';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');

test('YouTube: удержание и drag защищены от чужой перемотки до отпускания', async ({}, testInfo) => {
  await livePair(testInfo, async ({ a, b, room, record, guestUid }) => {
    for (const gesture of ['keyboard', 'pointer'] as const) {
      await readyPlayer(b);
      const initial = (await room()).playback.revision;
      await b.locator('#movie_player').focus();
      const bar = b.locator('.ytp-progress-bar').first();
      if (gesture === 'keyboard') {
        await b.keyboard.down('ArrowRight');
        await b.waitForTimeout(500); // Начальная пауза перед автоповтором.
        await b.keyboard.down('ArrowRight');
        await b.keyboard.down('ArrowRight');
      } else {
        await bar.hover();
        const bounds = (await bar.boundingBox())!;
        await record('pointer: bounds', { bounds });
        // Короткий переход проверяет конфликт жестов отдельно от долгой загрузки media.
        await b.mouse.move(bounds.x + bounds.width * 0.04, bounds.y + bounds.height / 2);
        await b.mouse.down();
        await b.mouse.move(bounds.x + bounds.width * 0.06, bounds.y + bounds.height / 2, { steps: 8 });
      }
      try {
        await b.waitForTimeout(300);
        expect((await room()).playback.revision).toBe(initial);
        const held = await sample(b);
        // Разные браузеры: фокус A не вызывает blur в B.
        await seek(a, 'ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(initial + 1);
        await b.waitForTimeout(350);
        expect(Math.abs((await sample(b)).positionSeconds - held.positionSeconds)).toBeLessThan(0.5);
        expect((await room()).playback.revision).toBe(initial + 1);
        await record(`${gesture}: remote seek does not interrupt held gesture`);
      } finally {
        if (gesture === 'keyboard') await b.keyboard.up('ArrowRight');
        else await b.mouse.up();
      }
      try {
        await expect.poll(async () => (await room()).playback.revision).toBe(initial + 2);
      } catch (error) {
        await record(`${gesture}: release failed`, { media: await b.locator('video.html5-main-video').first().evaluate((v: HTMLVideoElement) => ({
          readyState: v.readyState, seeking: v.seeking, error: v.error?.code,
          ad: !!v.closest('.ad-showing, .ad-interrupting'),
        })) });
        throw error;
      }
      const final = (await room()).playback;
      expect(final.actorUid).toBe(guestUid);
      await converged(a, b, final);
      await b.waitForTimeout(700);
      expect((await room()).playback).toEqual(final);
      await record(`${gesture}: release wins, both players converge, no echo`);
    }
  });
});
