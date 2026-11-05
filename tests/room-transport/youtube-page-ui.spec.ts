import { expect, test } from '@playwright/test';
import { frameOf, openDetails } from './fixtures';
import { readyPlayer, sample } from './playback-fixture';
import { converged, livePair } from './youtube-matrix-fixture';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
test.setTimeout(180_000);

test('YouTube: UI комнаты, настоящий SPA, локальный просмотр, общая смена и выход', async ({}, info) => {
  await livePair(info, async ({ a, b, room, record }) => {
    await a.bringToFront();
    await a.reload({ waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    let frame = await frameOf(a, false);
    const name = await frame.locator('#room-name').textContent();
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: 2');
    await expect.poll(async () => (await a.title()).startsWith(`${name} | `)).toBe(true);
    const initial = (await room()).playback;
    const originalId = initial.videoId;
    const target = new URL(frame.url()).hash;
    await openDetails(frame);
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
    await a.context().grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
    const invitation = await a.evaluate(() => navigator.clipboard.readText());
    await frame.locator('#room-toggle').press('Enter');
    expect((await room()).playback).toEqual(initial);
    await a.screenshot({ path: info.outputPath('youtube-page-ui.png') });
    await record('compact UI and title after reload; details do not change playback');
    const recommendation = a.locator('a[href*="watch?v="]').filter({ visible: true }).first();
    const next = new URL((await recommendation.getAttribute('href'))!, 'https://www.youtube.com').searchParams.get('v')!;
    expect(next).not.toBe(originalId);
    await recommendation.click();
    await expect.poll(() => new URL(a.url()).searchParams.get('v')).toBe(next);
    frame = await frameOf(a, false);
    expect(new URL(frame.url()).hash).toBe(target);
    await expect(frame.locator('#status')).toContainText('Локальный просмотр');
    await expect.poll(async () => (await a.title()).startsWith(`${name} | `)).toBe(true);
    expect((await room()).playback).toEqual(initial);
    await openDetails(frame);
    await frame.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect.poll(() => new URL(a.url()).searchParams.get('v')).toBe(originalId);
    await converged(a, b, (await room()).playback);
    expect((await room()).playback.revision).toBe(initial.revision);
    await record('real watch SPA and explicit return preserve revision', { nextVideoId: next });
    // SPA выше использует настоящую рекомендацию; общую смену проверяем на
    // известном записанном ролике, независимо от персонализации рекомендаций.
    const sharedVideo = 'ZSn3Tvc7jQU';
    await a.goto(`https://www.youtube.com/watch?v=${sharedVideo}&hl=en`, { waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    frame = await frameOf(a);
    // Дожидаемся инициализации самого YouTube, затем ставим на паузу его
    // настоящим контролом. Ранняя media.pause() могла быть отменена autoplay.
    await expect(frame.locator('#status')).toContainText('Локальный просмотр');
    let pausedSince = 0;
    await expect.poll(async () => {
      if ((await sample(a)).isPlaying) {
        await a.locator('.ytp-play-button').click(); pausedSince = 0; return false;
      }
      pausedSince ||= Date.now();
      return Date.now() - pausedSince >= 1500;
    }, { timeout: 20_000, intervals: [250] }).toBe(true);
    expect((await room()).playback).toEqual(initial);
    await frame.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: sharedVideo, revision: initial.revision + 1, isPlaying: false });
    await record('paused shared switch accepted');
    await converged(a, b, (await room()).playback);
    await record('local SPA, explicit return and shared video switch');
    const afterSwitch = (await room()).playback;
    for (const page of [a, b]) {
      await expect.poll(() => page.title()).toContain(`${name} | `);
    }
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
    expect(await a.evaluate(async link => (await navigator.clipboard.readText()) === link, invitation)).toBe(true);
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect.poll(async () => (await frame.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility)).toBe('hidden');
    await expect.poll(() => a.title()).not.toContain(`${name} | `);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(1);
    expect((await room()).playback).toEqual(afterSwitch);
    await record('page leave clears title without playback revision');
  });
});
