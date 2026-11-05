import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { frameOf, popup, settlePanel, setup, watch } from './fixtures';
import { readyPlayer, sample } from './playback-fixture';
import type { Playback } from '../../src/lib/playback/model';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1' || process.env.TRANSPORT_HEADED !== '1',
  'Opt-in: настоящий YouTube и видимый Chromium с мышью.');
test.setTimeout(120_000);

test('YouTube: drag панели, штатный fullscreen и малое окно', async ({}, info) => {
  const { context, extensionId } = await setup(true, undefined, false);
  try {
    const page = await context.newPage();
    await page.goto(`${watch}&hl=en`, { waitUntil: 'domcontentloaded' });
    await readyPlayer(page);
    let pausedSince = 0;
    await expect.poll(async () => {
      if ((await sample(page)).isPlaying) {
        await page.locator('.ytp-play-button').click(); pausedSince = 0; return false;
      }
      pausedSince ||= Date.now();
      return Date.now() - pausedSince >= 1500;
    }, { timeout: 20_000, intervals: [250] }).toBe(true);
    const control = await popup(context, page, extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const before = ((await control.request(target)).room as { playback: Playback }).playback;
    await control.close();
    await page.bringToFront();
    const title = await page.title();
    const box = async () => (await (await frame.frameElement()).boundingBox())!;
    const positions: Record<string, unknown>[] = [];
    for (const expanded of [false, true]) {
      if (await frame.locator('#room-toggle').getAttribute('aria-expanded') !== String(expanded)) {
        await frame.locator('#room-toggle').press('Enter');
      }
      await settlePanel(frame);
      const initial = await box();
      const header = (await frame.locator('#room-toggle').boundingBox())!;
      const start = { x: header.x + 30, y: header.y + 20 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 20; step++) {
        await page.mouse.move(start.x + 100 * step / 20, start.y - 60 * step / 20);
        await page.waitForTimeout(25);
      }
      await page.mouse.up();
      await expect.poll(async () => (await box()).x).toBeCloseTo(initial.x + 100, 0);
      await expect.poll(async () => (await box()).y).toBeCloseTo(initial.y - 60, 0);
      await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', String(expanded));
      positions.push({ expanded, before: initial, after: await box() });
    }
    const moved = await box();
    await page.locator('.ytp-fullscreen-button').click();
    const visible = async () => (await frame.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility);
    await expect.poll(visible).toBe('hidden');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    expect(await page.title()).toBe(title);
    await page.locator('.ytp-fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect.poll(visible).toBe('visible');
    expect(await box()).toEqual(moved);
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize({ width: 640, height: 480 });
    await settlePanel(frame);
    await frame.locator('#leave').scrollIntoViewIfNeeded();
    await expect(frame.locator('#leave')).toBeInViewport();
    const small = await box();
    expect(small.x + small.width).toBeLessThanOrEqual(628);
    expect(small.y + small.height).toBeLessThanOrEqual(468);
    const check = await popup(context, page, extensionId);
    expect(((await check.request(target)).room as { playback: Playback }).playback).toEqual(before);
    await check.close();
    await frame.locator('#leave').press('Enter');
    await expect.poll(visible).toBe('hidden');
    const path = info.outputPath('youtube-panel-position-observations.json');
    await writeFile(path, JSON.stringify({ browserVersion: context.browser()!.version(),
      headless: false, fullscreenEntry: 'YouTube .ytp-fullscreen-button (entry and exit)',
      positions, restored: moved, small, playbackUnchanged: true, released: true }, null, 2));
    await info.attach('youtube-panel-position-observations', { path, contentType: 'application/json' });
  } finally { await context.close(); }
});
