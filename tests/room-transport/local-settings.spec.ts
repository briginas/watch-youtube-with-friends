import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { frameOf, popup, setup, watch } from './fixtures';
import { playerFixture, readyPlayer, sample } from './playback-fixture';
import type { Playback } from '../../src/lib/playback/model';
import type { RoomMetadata } from '../../src/lib/room/metadata';

test.use({ actionTimeout: 15_000 });

async function personal(page: Page) {
  return page.locator('video.html5-main-video').first().evaluate((v: HTMLVideoElement) => ({
    volume: v.volume, muted: v.muted,
    subtitles: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
  }));
}

async function qualityMenu(page: Page) {
  const menu = page.locator('.ytp-settings-menu');
  if (!await menu.isVisible()) await page.locator('.ytp-settings-button').click();
  const entry = menu.locator('.ytp-menuitem').filter({ hasText: /^Quality/ });
  if (await entry.isVisible()) await entry.click();
  const items = menu.locator('[role="menuitemradio"]:visible');
  await expect(items.first()).toBeVisible();
  return items;
}

async function selectedQuality(page: Page, live: boolean) {
  if (!live) return page.locator('.ytp-quality-menu [aria-checked="true"]').innerText();
  const items = await qualityMenu(page);
  const selected = await items.and(page.locator('[aria-checked="true"]')).innerText();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ytp-settings-menu')).toBeHidden();
  return selected;
}

for (const live of [false, true]) test(`${live ? 'YouTube' : 'видеостенд'}: громкость, качество и субтитры локальны в двух profiles`, async ({}, testInfo) => {
  test.skip(live && process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  test.setTimeout(live ? 240_000 : 90_000);
  const first = await setup(live, playerFixture());
  const second = await setup(live, playerFixture());
  const checkpoints: unknown[] = [];
  try {
    const a = await first.context.newPage();
    // Live-проверка использует отдельный ролик с доступными субтитрами.
    await a.goto(live ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : watch, { waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    await a.locator('video.html5-main-video').first().evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 5; });
    await readyPlayer(a);
    const control = await popup(first.context, a, first.extensionId);
    const target = new URL((await frameOf(a)).url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const created = await control.request(target);
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    const room = async (): Promise<{ metadata: RoomMetadata; playback: Playback; presence: Record<string, unknown> }> => {
      const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
        headers: { Authorization: 'Bearer owner' },
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await control.close();
    const invite = await second.context.newPage();
    await invite.goto(created.invitation!);
    await expect.poll(() => invite.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const frame = invite.frames().find(f => f.url().includes('/invitation.html#'))!;
    const opened = second.context.waitForEvent('page');
    await frame.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    await expect((await frameOf(b)).getByRole('listitem')).toHaveCount(2);
    const uids = Object.keys((await room()).presence);
    expect(uids).toHaveLength(2);
    expect(uids).toContain(created.uid);
    for (const page of [a, b]) {
      await expect.poll(() => sample(page)).toMatchObject({ isPlaying: false, playbackRate: 1 });
      await expect.poll(async () => Math.abs((await sample(page)).positionSeconds - 5)).toBeLessThan(0.5);
    }
    await b.waitForTimeout(500);
    // YouTube может завершить собственный autoplay уже после первого snapshot.
    // Явный общий play/pause завершает начальную загрузку обоих плееров.
    let initialRevision = (await room()).playback.revision;
    await a.bringToFront();
    await a.locator('video.html5-main-video').first().evaluate((v: HTMLVideoElement) => v.pause());
    await a.locator('.ytp-play-button').click();
    await expect.poll(async () => (await room()).playback.revision).toBe(++initialRevision);
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ isPlaying: true });
    await readyPlayer(a);
    await readyPlayer(b);
    await b.waitForTimeout(700);
    await b.bringToFront();
    await b.locator('.ytp-play-button').click();
    await expect.poll(async () => (await room()).playback.revision).toBe(++initialRevision);
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ isPlaying: false });
    await b.waitForTimeout(700);
    if (live) for (const page of [a, b]) {
      // Явный выбор отключает позднее автоматическое включение дорожки YouTube.
      await page.bringToFront();
      const cc = page.locator('.ytp-subtitles-button');
      if ((await personal(page)).subtitles !== 'true') await cc.click();
      await expect(cc).toHaveAttribute('aria-pressed', 'true');
      await cc.click();
      await expect(cc).toHaveAttribute('aria-pressed', 'false');
    }
    await b.waitForTimeout(1800);
    expect((await room()).playback.revision).toBe(initialRevision);

    async function local(source: Page, other: Page, name: string, action: () => Promise<unknown>) {
      process.stdout.write(`Local settings QA: ${source === a ? 'creator' : 'guest'} ${name}\n`);
      await source.bringToFront();
      await readyPlayer(source);
      const before = await room();
      const otherPersonal = await personal(other);
      const otherPlayback = await sample(other);
      await action();
      await readyPlayer(source);
      // Дольше окна корреляции ввода адаптера (1500 мс), включая восстановление quality.
      await source.waitForTimeout(1800);
      const after = await room();
      expect(after.playback).toEqual(before.playback);
      expect(await personal(other)).toEqual(otherPersonal);
      expect(await sample(other)).toEqual(otherPlayback);
      expect(Object.keys(after).sort()).toEqual(['metadata', 'playback', 'presence']);
      expect(after.metadata).toEqual(before.metadata);
      expect(Object.keys(after.playback).sort()).toEqual([
        'actorUid', 'commandId', 'isPlaying', 'kind', 'playbackRate', 'positionSeconds', 'revision', 'updatedAt', 'videoId',
        'actionAt', 'sampledAt', 'videoRevision',
      ].sort());
      checkpoints.push({ source: source === a ? 'creator' : 'guest', action: name,
        revision: after.playback.revision, a: await personal(a), b: await personal(b) });
    }

    for (const [source, other] of [[a, b], [b, a]] as const) {
      await local(source, other, 'mute', async () => {
        const before = await personal(source);
        await source.locator('.ytp-mute-button').click();
        await expect.poll(() => personal(source)).toMatchObject({ muted: !before.muted });
      });
      await local(source, other, 'volume keyboard', async () => {
        const before = await personal(source);
        const slider = source.locator('.ytp-volume-panel');
        await slider.focus();
        await slider.press('ArrowLeft');
        await expect.poll(async () => (await personal(source)).volume).toBeLessThan(before.volume);
      });
      await local(source, other, 'subtitles', async () => {
        const before = await personal(source);
        await source.locator('.ytp-subtitles-button').click();
        await expect.poll(async () => (await personal(source)).subtitles).not.toBe(before.subtitles);
      });
      if (source === b) await local(source, other, 'subtitles keyboard', async () => {
        const before = await personal(source);
        await source.locator('#movie_player').focus();
        await source.keyboard.press('c');
        await expect.poll(async () => (await personal(source)).subtitles).not.toBe(before.subtitles);
      });
      // Проверяем выбранный пункт, а не автоматически меняющееся разрешение ABR.
      let chosen: string;
      const otherQuality = await selectedQuality(other, live);
      await local(source, other, 'quality', async () => {
        const items = live ? await qualityMenu(source) : source.locator('.ytp-quality-menu [role="menuitemradio"]');
        const option = items.filter({ hasText: source === a ? '360p' : '144p' }).first();
        chosen = await option.innerText();
        await option.click();
        if (live) {
          // Выбор закрывает popup асинхронно; не читаем уходящую панель.
          await expect(source.locator('.ytp-settings-menu')).toBeHidden();
          await readyPlayer(source);
          const selected = await qualityMenu(source);
          await expect(selected.and(source.locator('[aria-checked="true"]'))).toHaveText(chosen);
          await source.keyboard.press('Escape');
          await expect(source.locator('.ytp-settings-menu')).toBeHidden();
        } else await expect(option).toHaveAttribute('aria-checked', 'true');
      });
      expect(await selectedQuality(other, live)).toBe(otherQuality);
      checkpoints.push({ source: source === a ? 'creator' : 'guest', action: 'selected quality',
        selected: chosen!, other: otherQuality });
    }

    // Общая команда по-прежнему работает и не сбрасывает личные настройки.
    const settings = [await personal(a), await personal(b)];
    const qualities = [await selectedQuality(a, live), await selectedQuality(b, live)];
    const revision = (await room()).playback.revision;
    await a.bringToFront();
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(revision + 1);
    await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(0.5);
    await b.waitForTimeout(1800);
    expect((await room()).playback.revision).toBe(revision + 1);
    expect([await personal(a), await personal(b)]).toEqual(settings);
    expect([await selectedQuality(a, live), await selectedQuality(b, live)]).toEqual(qualities);
    checkpoints.push({ action: 'shared seek preserves personal settings', revision: revision + 1,
      a: await sample(a), b: await sample(b), settings, qualities });
  } finally {
    const output = testInfo.outputPath('local-settings-observations.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ live, browserVersion: first.context.browser()?.version(), checkpoints }, null, 2));
    await testInfo.attach('local-settings-observations', {
      path: output, contentType: 'application/json',
    });
    await second.context.close();
    await first.context.close();
  }
});
