import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { frameOf, openDetails, popup, setup, watch } from './fixtures';

import { playerFixture, sample, readyPlayer } from './playback-fixture';
import { russianRateShortcut } from '../keyboard';

for (const live of [false, true]) test(`${live ? 'настоящий YouTube' : 'видеостенд'}: play/pause, seek, rate в обе стороны без обратной рассылки`, async ({}, testInfo) => {
  const manual = process.env.SYNC_MANUAL === '1';
  test.skip(manual && !live, 'Ручной режим использует настоящий YouTube.');
  test.skip(live && process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  test.setTimeout(manual ? 600_000 : live ? 180_000 : 90_000);
  const first = await setup(live, playerFixture(), !manual);
  const second = await setup(live, playerFixture(), !manual);
  let roomUrl: string | undefined;
  let stage = 'open creator';
  let identity: { participantCount: number; distinctUids: boolean } | undefined;
  const checkpoints: { action: string; revision: number; source: number; a: unknown; b: unknown }[] = [];
  const nativeRates: { receiver: number; expected: number; playerRate: number; menu: string | null }[] = [];
  async function room() {
    const response = await fetch(roomUrl!, { headers: { Authorization: 'Bearer owner' } });
    expect(response.ok).toBe(true);
    return response.json();
  }
  try {
    const a = await first.context.newPage();
    await a.goto(watch, { waitUntil: 'domcontentloaded' });
    const video = a.locator('#movie_player video.html5-main-video').first();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 3 && Number.isFinite(v.duration)
      && !v.closest('.ad-showing, .ad-interrupting')), { timeout: 45_000 }).toBe(true);
    await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 5; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 3)).toBe(true);
    const control = await popup(first.context, a, first.extensionId);
    stage = 'create room';
    const sessionA = await frameOf(a);
    const target = new URL(sessionA.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const created = await control.request(target);
    const invitation = created.invitation!;
    const key = new URLSearchParams(new URL(invitation).hash.slice(1)).get('room')!;
    roomUrl = `http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`;
    await control.close();
    stage = 'join invitation';
    const invitationPage = await second.context.newPage();
    await invitationPage.goto(invitation);
    await expect.poll(() => invitationPage.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const frame = invitationPage.frames().find(f => f.url().includes('/invitation.html#'))!;
    const opened = second.context.waitForEvent('page');
    await frame.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    stage = 'apply initial state';
    const sessionB = await frameOf(b);
    await expect(sessionB.getByRole('listitem')).toHaveCount(2);
    const guestControl = await popup(second.context, b, second.extensionId);
    const guest = await guestControl.request(new URL(sessionB.url()).hash.slice(1));
    await guestControl.close();
    expect(typeof created.uid === 'string' && created.uid.length > 0).toBe(true);
    expect(typeof guest.uid === 'string' && guest.uid.length > 0).toBe(true);
    expect(guest.uid === created.uid).toBe(false);
    const uids = Object.keys((await room()).presence);
    expect(uids).toHaveLength(2);
    expect(uids.includes(created.uid!) && uids.includes(guest.uid!)).toBe(true);
    identity = { participantCount: uids.length, distinctUids: guest.uid !== created.uid };
    expect(b.url()).toBe(watch);
    await invitationPage.close();
    await expect.poll(() => sample(b)).toMatchObject({ isPlaying: false, playbackRate: 1 });
    await expect.poll(async () => Math.abs((await sample(b)).positionSeconds - 5), { timeout: 45_000 }).toBeLessThan(0.5);
    // Дожидаемся завершения начального применения перед следующим вводом.
    await b.waitForTimeout(500);
    let revision = 0;
    if (manual) {
      await a.evaluate(() => { document.title = 'Sync QA — A'; });
      await b.evaluate(() => { document.title = 'Sync QA — B'; });
      process.stdout.write('Manual QA ready: A play, pause, seek, rate; затем B play, pause, seek, rate.\n');
      for (const [source, name] of [[a, 'A'], [b, 'B']] as const) {
        for (const kind of ['play', 'pause', 'seek', 'rate']) {
          const before = (await room()).playback;
          revision++;
          await expect.poll(async () => (await room()).playback.revision, { timeout: 180_000 }).toBe(revision);
          const accepted = (await room()).playback;
          expect(accepted.actorUid === (source === a ? created.uid : guest.uid)).toBe(true);
          expect(accepted.isPlaying).toBe(kind === 'play');
          if (kind === 'seek') expect(Math.abs(accepted.positionSeconds - before.positionSeconds)).toBeGreaterThan(3);
          if (kind === 'rate') expect(accepted.playbackRate).toBeGreaterThan(before.playbackRate);
          for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({
            isPlaying: accepted.isPlaying, playbackRate: accepted.playbackRate,
          });
          await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(1);
          await source.waitForTimeout(700);
          expect((await room()).playback.revision).toBe(revision);
          checkpoints.push({ action: `${name}: ${kind} (native UI)`, source: source === a ? 1 : 2, revision, a: await sample(a), b: await sample(b) });
          process.stdout.write(`Manual QA verified: ${name} ${kind}, revision ${revision}\n`);
        }
      }
      return;
    }
    async function action(source: Page, name: string, run: () => Promise<unknown>, expected: { isPlaying?: boolean; playbackRate?: number; positionSeconds?: number }) {
      stage = name;
      await source.bringToFront();
      await readyPlayer(source);
      await run();
      revision++;
      await expect.poll(async () => (await room()).playback.revision).toBe(revision);
      const accepted = (await room()).playback;
      expect(accepted.actorUid === (source === a ? created.uid : guest.uid)).toBe(true);
      const { positionSeconds, ...expectedState } = expected;
      expect(accepted).toMatchObject(expectedState);
      if (positionSeconds !== undefined) expect(Math.abs(accepted.positionSeconds - positionSeconds)).toBeLessThan(0.5);
      for (const page of [a, b]) {
        await expect.poll(() => sample(page)).toMatchObject({ isPlaying: accepted.isPlaying, playbackRate: accepted.playbackRate });
        if (positionSeconds !== undefined) await expect.poll(async () => Math.abs((await sample(page)).positionSeconds - positionSeconds)).toBeLessThan(0.5);
      }
      await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds), { timeout: 20_000 }).toBeLessThan(1);
      await readyPlayer(a);
      await readyPlayer(b);
      // Несколько циклов адаптера после асинхронных media events: revision не растёт.
      await source.waitForTimeout(700);
      expect((await room()).playback.revision).toBe(revision);
      checkpoints.push({ action: name, revision, source: source === a ? 1 : 2, a: await sample(a), b: await sample(b) });
    }
    for (const [source, name] of [[a, 'creator'], [b, 'guest']] as const) {
      await action(source, `${name}: play`, () => source.locator('.ytp-play-button').click(), { isPlaying: true });
      await action(source, `${name}: pause (keyboard)`, async () => {
        await source.locator('#movie_player').focus(); await source.keyboard.press('k');
      }, { isPlaying: false });
      const beforeSeek = await sample(source);
      // Native YouTube scales the Arrow seek by its internal playback rate.
      // The controlled fixture uses a fixed five-second seek.
      const seekPosition = beforeSeek.positionSeconds + (source === a ? 5 : -5) * (live ? beforeSeek.playbackRate : 1);
      await action(source, `${name}: seek`, async () => {
        await source.locator('#movie_player').focus(); await source.keyboard.press(source === a ? 'ArrowRight' : 'ArrowLeft');
      }, { isPlaying: false, positionSeconds: seekPosition });
      await action(source, `${name}: rate`, async () => {
        if (live) {
          await source.locator('.ytp-settings-button').click();
          await source.locator('.ytp-menuitem').filter({ hasText: 'Playback speed' }).click();
          await source.locator('.ytp-variable-speed-panel-preset-button').filter({ hasText: name === 'creator' ? /^1\.25$/ : /^1\.5$/ }).click();
          await source.keyboard.press('Escape');
        } else {
          await source.locator('#movie_player').focus(); await source.keyboard.press('Shift+Period');
        }
      }, { playbackRate: name === 'creator' ? 1.25 : 1.5 });
    }
    // Every receiver must start its very first shortcut from the remote rate.
    for (const [source, receiver, name] of [[a, b, 'guest'], [b, a, 'creator']] as const) {
      await action(source, `${name}: receives remote rate 1.25`, async () => {
        await source.locator('#movie_player').focus(); await source.keyboard.press('Shift+Comma');
      }, { playbackRate: 1.25 });
      if (live) {
        await receiver.bringToFront();
        await receiver.locator('.ytp-settings-button').click();
        const menu = receiver.locator('.ytp-menuitem').filter({ hasText: 'Playback speed' });
        await expect(menu).toContainText('1.25');
        const playerRate = await receiver.locator('#movie_player').evaluate(root =>
          (root as HTMLElement & { getPlaybackRate: () => number }).getPlaybackRate());
        expect(playerRate).toBe(1.25);
        nativeRates.push({ receiver: receiver === a ? 1 : 2, expected: 1.25, playerRate, menu: await menu.textContent() });
        await receiver.keyboard.press('Escape');
      }
      await action(receiver, `${name}: first > after remote rate`, async () => {
        await receiver.locator('#movie_player').focus(); await receiver.keyboard.press('Shift+Period');
      }, { playbackRate: 1.5 });
      if (live) {
        for (const direction of ['down', 'up'] as const) await action(receiver, `${name}: Russian ${direction}`, async () => {
          await receiver.locator('#movie_player').focus(); await russianRateShortcut(receiver, direction);
        }, { playbackRate: direction === 'down' ? 1.25 : 1.5 });
      }
    }
    // Выход удаляет адаптер: последующие trusted controls остаются локальными.
    stage = 'creator leaves';
    await a.bringToFront();
    await openDetails(sessionA);
    await sessionA.getByRole('button', { name: 'Выйти из комнаты', exact: true }).focus();
    await sessionA.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
    await expect(sessionA.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    await expect.poll(async () => Object.keys((await room()).presence)).toEqual([guest.uid]);
    await a.locator('.ytp-play-button').click();
    await a.waitForTimeout(500);
    expect((await room()).playback.revision).toBe(revision);
    expect((await sample(b)).isPlaying).toBe(false);
    await b.locator('.ytp-play-button').click();
    await expect.poll(async () => (await room()).playback.revision).toBe(revision + 1);
    await expect.poll(async () => (await room()).playback.isPlaying).toBe(true);
    expect((await room()).playback.actorUid === guest.uid).toBe(true);
    await expect.poll(() => sample(b)).toMatchObject({ isPlaying: true, playbackRate: 1.5 });
    await readyPlayer(b);
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(revision + 1);
    checkpoints.push({ action: 'guest: play after creator leaves', revision: revision + 1, source: 2, a: await sample(a), b: await sample(b) });
    stage = 'complete';
  } finally {
    const output = testInfo.outputPath('sync-observations.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ live, manual, stage, browserVersion: first.context.browser()?.version(), identity, nativeRates, checkpoints }, null, 2));
    await testInfo.attach('sync-observations', { path: output, contentType: 'application/json' });
    await second.context.close(); await first.context.close();
  }
});
