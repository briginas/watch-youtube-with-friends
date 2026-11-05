import { test, expect, type Page } from '@playwright/test';
import { frameOf, popup, setup, watch } from './fixtures';
import { playerFixture, readyPlayer, sample } from './playback-fixture';
import type { Playback } from '../../src/lib/playback/model';

// Политика autoplay проверяется без trace snapshots и Playwright evaluations
// в watch-документе гостя: они дают ему user activation.
test.use({ trace: 'off' });

async function pair(run: (pair: {
  a: Page; b: Page; room: () => Promise<{ playback: Playback; presence?: Record<string, unknown> }>;
}) => Promise<void>, autoplay = false, live = false) {
  const first = await setup(live, playerFixture());
  const second = await setup(live, playerFixture(), true, autoplay ? [
    '--autoplay-policy=document-user-activation-required',
    '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
  ] : []);
  try {
    const a = await first.context.newPage();
    await a.goto(watch);
    await readyPlayer(a);
    await a.locator('video.html5-main-video').first().evaluate((v: HTMLVideoElement) => { v.pause(); });
    const control = await popup(first.context, a, first.extensionId);
    const sessionA = await frameOf(a);
    const target = new URL(sessionA.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const created = await control.request(target);
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    const room = async () => {
      const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
        headers: { Authorization: 'Bearer owner' },
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await control.close();
    await a.waitForTimeout(500);
    if (autoplay) {
      await a.locator('.ytp-play-button').click();
      await expect.poll(async () => (await room()).playback.revision).toBe(1);
    }
    const invite = await second.context.newPage();
    await invite.goto(created.invitation!);
    await expect.poll(() => invite.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const invitationFrame = invite.frames().find(f => f.url().includes('/invitation.html#'))!;
    const opened = second.context.waitForEvent('page');
    await invitationFrame.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    if (!autoplay) {
      await expect.poll(() => sample(b)).toMatchObject({ isPlaying: false, playbackRate: 1 });
      await b.waitForTimeout(500);
    }
    await run({ a, b, room });
  } finally {
    await second.context.close();
    await first.context.close();
  }
}

test('смена поколения после autoplay-blocked: восстановление нового ролика и общей скорости без эха', async ({}, testInfo) => {
  await pair(async ({ a, b, room }) => {
    const initialSession = await frameOf(b, false);
    await expect(initialSession.locator('#status')).toHaveText('Нажмите play, чтобы продолжить');
    await a.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(a);
    await a.locator('.ytp-variable-speed-panel-button').click();
    await a.locator('.ytp-play-button').click();
    await (await frameOf(a)).getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
    await expect.poll(async () => (await room()).playback).toMatchObject({
      revision: 2, videoRevision: 2, videoId: 'dQw4w9WgXcQ', playbackRate: 1.5, isPlaying: true,
    });
    // Page.toHaveURL использует evaluation в watch и даёт user activation.
    await expect.poll(() => b.url()).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const session = await frameOf(b);
    // Chrome может разрешить autoplay после навигации в уже посещённом origin.
    // В обоих случаях старый blocked-status должен уступить состоянию нового видео.
    await expect.poll(() => session.locator('#player-status').textContent()).toMatch(/^(|Нажмите play, чтобы продолжить)$/);
    const blocked = (await session.locator('#player-status').textContent()) === 'Нажмите play, чтобы продолжить';
    await testInfo.attach('new-generation-autoplay', { body: JSON.stringify({ blocked }), contentType: 'application/json' });
    await b.waitForTimeout(600);
    expect((await room()).playback.revision).toBe(2);
    if (blocked) await b.locator('.ytp-play-button').click();
    await expect.poll(() => sample(b)).toMatchObject({ isPlaying: true, playbackRate: 1.5 });
    await expect(session.locator('#player-status')).toBeHidden();
    await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(0.5);
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(2);
  }, true);
});

for (const restriction of ['ad', 'buffering'] as const) {
  for (const newCommands of [false, true]) {
    test(`${restriction}: восстановление ${newCommands ? 'последней revision' : 'без новых команд'}, без обратной рассылки`, async () => {
      await pair(async ({ a, b, room }) => {
        const sessionB = await frameOf(b);
        const initial = (await room()).playback;
        await b.evaluate(kind => {
          const v = document.querySelector('video')!;
          if (kind === 'ad') {
            document.querySelector('#movie_player')!.classList.add('ad-showing');
            v.currentTime = 30;
          }
          else v.dispatchEvent(new Event('waiting'));
          v.playbackRate = 2;
        }, restriction);
        if (restriction === 'ad') {
          await expect(sessionB.locator('#player-status')).toContainText('Реклама');
          await expect(sessionB.locator('#status')).toContainText('Реклама');
        } else {
          await expect(sessionB.locator('.buffering-spinner')).toBeVisible();
          await expect(sessionB.locator('#player-status')).toBeHidden();
        }
        // Trusted controls во время ограничения тоже остаются локальными.
        await b.locator('.ytp-variable-speed-panel-button').click();
        if (restriction === 'ad') await b.locator('.ytp-play-button').click();
        await b.waitForTimeout(400);
        expect((await room()).playback).toEqual(initial);
        expect(await sample(a)).toMatchObject({ isPlaying: false, playbackRate: 1 });
        if (newCommands) {
          await a.bringToFront();
          await a.locator('#movie_player').focus();
          await a.keyboard.press('ArrowRight');
          await expect.poll(async () => (await room()).playback.revision).toBe(1);
          await a.locator('.ytp-variable-speed-panel-button').click();
          await expect.poll(async () => (await room()).playback.revision).toBe(2);
          await a.locator('.ytp-play-button').click();
          await expect.poll(async () => (await room()).playback.revision).toBe(3);
        }
        // На ограниченном клиенте ещё действуют собственные media settings.
        if (restriction === 'ad') expect((await sample(b)).positionSeconds).toBeGreaterThan(25);
        else expect(await sample(b)).toMatchObject({ isPlaying: false, playbackRate: 1.5 });
        const latest = (await room()).playback;
        await b.evaluate(kind => {
          if (kind === 'ad') document.querySelector('#movie_player')!.classList.remove('ad-showing');
          else document.querySelector('video')!.dispatchEvent(new Event('canplay'));
        }, restriction);
        await expect.poll(() => sample(b)).toMatchObject({ isPlaying: latest.isPlaying, playbackRate: latest.playbackRate });
        await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(0.5);
        await expect(sessionB.locator('#player-status')).toBeHidden();
        await expect(sessionB.locator('.buffering-spinner')).toBeHidden();
        await b.waitForTimeout(700);
        expect((await room()).playback).toEqual(latest);
        // После восстановления обычный локальный ввод снова работает.
        await b.locator('#movie_player').focus();
        await b.keyboard.press('ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
      });
    });
  }
}

test('ошибка YouTube локальна; перезагрузка видео восстанавливает последнюю revision и UID', async () => {
  await pair(async ({ a, b, room }) => {
    const before = await room();
    const uids = Object.keys(before.presence ?? {}).sort();
    await b.locator('#movie_player').evaluate(root => {
      root.insertAdjacentHTML('beforeend', '<div class="ytp-error-content-wrap">Something went wrong</div>');
    });
    const session = await frameOf(b);
    await expect(session.locator('#player-status')).toContainText('Видео недоступно');
    await expect(session.locator('#status')).toContainText('Видео недоступно');
    const reload = session.getByRole('link', { name: 'Перезагрузить видео' });
    await expect(reload).toHaveAttribute('href', watch);
    await a.bringToFront();
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(before.playback.revision + 1);
    const latest = (await room()).playback;
    await reload.press('Enter');
    await expect.poll(() => b.frames().some(frame => frame.url().includes('/session.html#'))).toBe(true);
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: latest.positionSeconds, isPlaying: false });
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).sort()).toEqual(uids);
    await expect((await frameOf(b)).locator('#player-status')).toBeHidden();
    await b.waitForTimeout(500);
    expect((await room()).playback).toEqual(latest);
    await b.locator('.ytp-play-button').click();
    await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
  });
});

for (const live of [false, true]) for (const pauseWhileBlocked of [false, true]) {
  test(`${live ? 'YouTube' : 'видеостенд'}: настоящий отказ autoplay, первый play локальный, последнее состояние ${pauseWhileBlocked ? 'pause' : 'play'}`, async () => {
    test.skip(live && process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
    test.setTimeout(live ? 180_000 : 90_000);
    await pair(async ({ a, b, room }) => {
      const cdp = await b.context().newCDPSession(b);
      const read = async (expression: string) => {
        const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false });
        expect(result.exceptionDetails).toBeUndefined();
        return result.result.value;
      };
      await expect.poll(() => b.frames().some(f => f.url().includes('/session.html#'))).toBe(true);
      const session = b.frames().find(f => f.url().includes('/session.html#'))!;
      const frameCdp = await b.context().newCDPSession(session);
      await expect.poll(async () => (await frameCdp.send('Runtime.evaluate', {
        expression: 'document.querySelector("#status")?.textContent', returnByValue: true, userGesture: false,
      })).result.value).toContain('Нажмите play');
      expect(await read('navigator.userActivation.hasBeenActive')).toBe(false);
      expect(await read('document.querySelector("video").paused')).toBe(true);
      const before = (await room()).playback;
      expect(before.revision).toBe(1);
      expect(before.isPlaying).toBe(true);
      if (pauseWhileBlocked) {
        await a.locator('.ytp-play-button').click();
        await expect.poll(async () => (await room()).playback.revision).toBe(2);
      } else {
        await a.locator('#movie_player').focus();
        await a.keyboard.press('ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(2);
      }
      const latest = (await room()).playback;
      await b.locator('.ytp-play-button').click();
      await expect.poll(() => sample(b)).toMatchObject({ isPlaying: latest.isPlaying, playbackRate: latest.playbackRate });
      await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(0.5);
      await expect((await frameOf(b)).locator('#player-status')).toBeHidden();
      await b.waitForTimeout(700);
      expect((await room()).playback).toEqual(latest);
      await b.locator('.ytp-play-button').click();
      await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
      await cdp.detach();
      await frameCdp.detach();
    }, true, live);
  });
}
