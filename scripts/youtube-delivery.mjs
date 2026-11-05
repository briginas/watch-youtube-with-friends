import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { observeMedia } from '../tests/cloud/diagnostics.ts';

// Control experiment: real YouTube without the extension or Firebase.
const position = Number(process.env.YOUTUBE_PROBE_POSITION ?? 45);
if (!Number.isFinite(position) || position < 0) throw new Error('Некорректный YOUTUBE_PROBE_POSITION.');
const output = resolve('.output/youtube-delivery');
await mkdir(output, { recursive: true });
const headless = process.env.YOUTUBE_PROBE_HEADLESS !== '0';
const channel = process.env.YOUTUBE_PROBE_CHANNEL ?? 'chromium';
if (!['chromium', 'chrome'].includes(channel)) throw new Error('YOUTUBE_PROBE_CHANNEL: chromium|chrome.');
const browser = await chromium.launch({ channel, headless });
const context = await browser.newContext();
const events = await observeMedia(context);
const page = await context.newPage();
const samples = [];
const startedAt = new Date().toISOString();
let complete = false;
const read = () => page.evaluate(() => {
  const video = document.querySelector('video.html5-main-video');
  const player = document.querySelector('#movie_player');
  const status = player?.getPlayerResponse?.()?.playabilityStatus;
  return { position: video?.currentTime, readyState: video?.readyState, networkState: video?.networkState,
    paused: video?.paused, status: status?.status, reason: status?.reason,
    error: document.querySelector('.ytp-error-content-wrap')?.textContent?.slice(0, 500) };
});
try {
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ&hl=en', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('video.html5-main-video')?.readyState >= 3, undefined, { timeout: 45_000 });
  await page.evaluate(seconds => {
    const video = document.querySelector('video.html5-main-video');
    video.pause(); video.currentTime = seconds;
  }, position);
  await page.waitForFunction(() => document.querySelector('video.html5-main-video')?.readyState >= 3, undefined, { timeout: 30_000 });
  await page.locator('#movie_player').focus();
  await page.keyboard.press('k');
  for (let index = 0; index < 12; index++) {
    await page.waitForTimeout(3000);
    const state = await read();
    samples.push(state);
    process.stdout.write(`${JSON.stringify(state)}\n`);
    if (state.readyState === 0) break;
  }
  complete = samples.length === 12 && samples.every(state => state.readyState > 0);
} finally {
  const state = await read().catch(() => null);
  await writeFile(`${output}/observations.json`, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
    extension: false, firebase: false, browser: browser.version(), channel, headless, videoId: 'aqz-KE-bpKQ', position,
    complete, state, samples, events }, null, 2));
  await page.screenshot({ path: `${output}/player.png` }).catch(() => {});
  await browser.close();
}
if (!complete) process.exitCode = 1;
