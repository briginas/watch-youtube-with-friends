import { expect, test, type Page } from '@playwright/test';
import { frameOf, watch } from './fixtures';
import { readyPlayer, sample } from './playback-fixture';
import { converged, livePair } from './youtube-matrix-fixture';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
test.setTimeout(180_000);

const url = (id: string) => `https://www.youtube.com/watch?v=${id}&hl=en`;
async function localVideo(page: Page, videoId: string, position: number) {
  await page.goto(url(videoId), { waitUntil: 'domcontentloaded' });
  await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe(videoId);
  await readyPlayer(page);
  await page.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement, at) => {
    v.pause(); v.currentTime = at;
  }, position);
  await readyPlayer(page);
}

test('YouTube: локальный SPA, смена от обоих участников, reload detached и возврат', async ({}, testInfo) => {
  await livePair(testInfo, async ({ a, b, room, record, creatorUid, guestUid }) => {
    const original = new URL(watch).searchParams.get('v')!;
    const pages = [a.context().pages().length, b.context().pages().length];
    const initialTarget = new URL((await frameOf(a)).url()).hash;
    // Настоящая рекомендация сайта; без history.pushState и внутренних API YouTube.
    const recommendation = a.locator('a[href*="watch?v="]').filter({ visible: true }).first();
    await expect(recommendation).toBeVisible();
    const next = new URL((await recommendation.getAttribute('href'))!, 'https://www.youtube.com').searchParams.get('v')!;
    expect(next).not.toBe(original);
    // На SPA старый video ещё ready после смены URL. Ждём metadata нового
    // источника, иначе подготовка snapshot попадает в загрузку следующего видео.
    await a.evaluate(() => {
      document.documentElement.dataset.qaSwitchMetadata = 'pending';
      const loaded = (event: Event) => {
        if (!(event.target instanceof HTMLVideoElement) || !event.target.matches('#movie_player video.html5-main-video')) return;
        document.documentElement.dataset.qaSwitchMetadata = 'loaded';
        document.removeEventListener('loadedmetadata', loaded, true);
      };
      document.addEventListener('loadedmetadata', loaded, true);
    });
    await recommendation.click();
    await expect.poll(() => new URL(a.url()).searchParams.get('v')).toBe(next);
    await expect(a.locator('html')).toHaveAttribute('data-qa-switch-metadata', 'loaded', { timeout: 30_000 });
    await readyPlayer(a);
    await a.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 20; });
    await readyPlayer(a);
    const session = await frameOf(a);
    expect(new URL(session.url()).hash).toBe(initialTarget);
    await expect(session.locator('#player-status')).toContainText('Не синхронизируется');
    expect((await room()).playback.revision).toBe(0);
    await session.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).click();
    try {
      await expect(session.locator('#switch-status')).toHaveText('Видео комнаты изменено.');
      await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: next, revision: 1, videoRevision: 1, actorUid: creatorUid });
    } finally {
      await record('creator switch result', { switchStatus: await session.locator('#switch-status').textContent(),
        media: await a.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => ({
          duration: v.duration, seeking: v.seeking, readyState: v.readyState,
          ad: !!v.closest('.ad-showing, .ad-interrupting'), error: v.error?.code ?? null,
        })) });
    }
    await expect.poll(() => new URL(b.url()).searchParams.get('v')).toBe(next);
    await converged(a, b, (await room()).playback);
    await record('creator switch: same room, loaded native players');
    await localVideo(b, original, 30);
    await (await frameOf(b)).getByRole('button', { name: 'Смотреть это в комнате', exact: true }).click();
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: original, revision: 2, videoRevision: 2, actorUid: guestUid });
    await expect.poll(() => new URL(a.url()).searchParams.get('v')).toBe(original);
    await converged(a, b, (await room()).playback);
    await record('guest switch: native players converged');
    await localVideo(b, next, 40);
    await b.reload({ waitUntil: 'domcontentloaded' });
    await readyPlayer(b);
    const detached = await frameOf(b);
    await expect(detached.locator('#player-status')).toContainText('Не синхронизируется');
    await detached.getByRole('link', { name: 'Вернуться в комнату' }).click();
    await expect.poll(() => new URL(b.url()).searchParams.get('v')).toBe(original);
    await converged(a, b, (await room()).playback);
    await b.waitForTimeout(1000);
    expect((await room()).playback.revision).toBe(2);
    expect([a.context().pages().length, b.context().pages().length]).toEqual(pages);
    expect((await sample(b)).isPlaying).toBe((await room()).playback.isPlaying);
    await record('detached reload and explicit return: no revision or echo', { tabsUnchanged: true, otherUrl: url(next) });
  });
});
