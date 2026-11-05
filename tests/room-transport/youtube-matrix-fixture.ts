import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { frameOf, popup, setup, watch } from './fixtures';
import { readyPlayer, sample } from './playback-fixture';
import type { Playback } from '../../src/lib/playback/model';

export type LivePair = {
  first: Awaited<ReturnType<typeof setup>>;
  second: Awaited<ReturnType<typeof setup>>;
  a: Page; b: Page;
  creatorUid: string; guestUid: string;
  room: () => Promise<{ playback: Playback; presence?: Record<string, unknown> }>;
  record: (name: string, details?: Record<string, unknown>) => Promise<void>;
};

// Только настоящий YouTube, основной src/, Anonymous Auth и продуктовые Rules.
// Admin-доступ используется только для чтения; секреты/UID в отчёт не попадают.
export async function livePair(testInfo: TestInfo, run: (pair: LivePair) => Promise<void>,
  configure?: (context: BrowserContext, index: number) => Promise<void>,
  options: { videoId?: string; headless?: boolean; inspectGuest?: (a: Page, b: Page, room: LivePair['room']) => Promise<Record<string, unknown>> } = {}) {
  const first = await setup(true, undefined, options.headless ?? true);
  const second = await setup(true, undefined, options.headless ?? true);
  const checkpoints: Record<string, unknown>[] = [];
  let complete = false;
  let stage = 'configure';
  try {
    await configure?.(first.context, 0);
    await configure?.(second.context, 1);
    const a = await first.context.newPage();
    stage = 'open creator';
    await a.goto(`${options.videoId ? `https://www.youtube.com/watch?v=${options.videoId}` : watch}&hl=en`, { waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    stage = 'prepare creator';
    await a.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => {
      v.pause(); v.currentTime = 10; v.playbackRate = 1;
    });
    await readyPlayer(a);
    stage = 'creator popup';
    const control = await popup(first.context, a, first.extensionId);
    const target = new URL((await frameOf(a)).url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    stage = 'create room';
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const created = await control.request(target);
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    const room: LivePair['room'] = async () => {
      const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
        headers: { Authorization: 'Bearer owner' },
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await control.close();
    stage = 'open invitation';
    const invitation = await second.context.newPage();
    await invitation.goto(created.invitation!);
    await expect.poll(() => invitation.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const opened = second.context.waitForEvent('page');
    stage = 'join invitation';
    await invitation.frames().find(f => f.url().includes('/invitation.html#'))!
      .getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    stage = 'inspect guest';
    if (options.inspectGuest) checkpoints.push(await options.inspectGuest(a, b, room));
    stage = 'guest session';
    const sessionB = await frameOf(b);
    await expect(sessionB.getByRole('listitem')).toHaveCount(2);
    stage = 'guest popup';
    const guestControl = await popup(second.context, b, second.extensionId);
    const guest = await guestControl.request(new URL(sessionB.url()).hash.slice(1));
    await guestControl.close();
    await invitation.close();
    expect(!!created.uid && !!guest.uid && created.uid !== guest.uid).toBe(true);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    stage = 'initial convergence';
    await converged(a, b, (await room()).playback);
    await b.waitForTimeout(700);
    const record: LivePair['record'] = async (name, details = {}) => {
      const state = await room();
      const { videoId, positionSeconds, playbackRate, isPlaying, revision } = state.playback;
      checkpoints.push({ name, ...details, playback: { videoId, positionSeconds, playbackRate, isPlaying, revision },
        participantCount: Object.keys(state.presence ?? {}).length, a: await sample(a), b: await sample(b) });
    };
    await record('joined', { distinctUids: true });
    stage = 'scenario';
    await run({ first, second, a, b, room, creatorUid: created.uid!, guestUid: guest.uid!, record });
    complete = true;
    stage = 'complete';
  } finally {
    const output = testInfo.outputPath('youtube-matrix-observations.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ scenario: testInfo.title, complete, stage,
      browserVersion: first.context.browser()?.version(), headless: options.headless ?? true, checkpoints }, null, 2));
    await testInfo.attach('youtube-matrix-observations', { path: output, contentType: 'application/json' });
    await second.context.close();
    await first.context.close();
  }
}

export async function seek(page: Page, direction: 'ArrowLeft' | 'ArrowRight') {
  await page.bringToFront();
  await readyPlayer(page);
  await page.locator('#movie_player').focus();
  await page.keyboard.press(direction);
}

export async function converged(a: Page, b: Page, state: Playback) {
  for (const page of [a, b]) {
    await readyPlayer(page);
    await expect.poll(() => sample(page), { timeout: 30_000 }).toMatchObject({
      isPlaying: state.isPlaying, playbackRate: state.playbackRate,
    });
    if (!state.isPlaying) await expect.poll(async () => Math.abs((await sample(page)).positionSeconds - state.positionSeconds),
      { timeout: 30_000 }).toBeLessThan(0.5);
  }
  await expect.poll(async () => Math.abs((await sample(a)).positionSeconds - (await sample(b)).positionSeconds)).toBeLessThan(0.5);
}
