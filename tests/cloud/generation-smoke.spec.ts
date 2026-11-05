import { expect, test } from '@playwright/test';
import { launchExtension } from '../e2e/fixtures';
import { frameOf, popup, watch, workerOf } from '../room-transport/fixtures';
import { readyPlayer } from '../room-transport/playback-fixture';
import { qaSettings } from '../../src/lib/firebase/qa-settings';
import { playbackSchema } from '../../src/lib/playback/model';

test('live QA: generation invite, one shared revision, stop/retry', async () => {
  test.skip(process.env.QA_GENERATION_SMOKE !== '1', 'Opt-in: выделенный live QA.');
  test.setTimeout(160_000);
  const config = qaSettings(process.env);
  const extension = '.output/cloud/chrome-mv3';
  const first = await launchExtension(extension, [], process.env.CLOUD_HEADLESS !== '0');
  const second = await launchExtension(extension, [], process.env.CLOUD_HEADLESS !== '0');
  const evidence = { control: false, join: false, auth: false, rest: false, command: false, recovery: false, foreign: 0 };
  try {
    const database = new URL(config.databaseURL).hostname;
    const controlHost = new URL(config.invitationBaseUrl).hostname;
    for (const context of [first, second]) {
      context.on('request', request => {
        const url = new URL(request.url());
        if (/\.(web\.app|firebaseapp\.com|firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname) &&
            url.hostname !== database && url.hostname !== controlHost) evidence.foreign++;
        if (['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'].includes(url.hostname) &&
            url.searchParams.get('key') !== config.apiKey) evidence.foreign++;
      });
    }
    second.on('response', response => {
      const url = new URL(response.url());
      if (response.ok() && url.hostname === 'identitytoolkit.googleapis.com' && url.pathname.endsWith('accounts:signUp')) evidence.auth = true;
      if (response.ok() && url.hostname === database && /^\/rooms\/[^/]+\.json$/.test(url.pathname)) evidence.rest = true;
    });
    const creatorId = new URL((await workerOf(first)).url()).host;
    const guestId = new URL((await workerOf(second)).url()).host;
    const a = await first.newPage();
    await a.goto(watch, { waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    const player = a.locator('video.html5-main-video').first();
    await player.evaluate((video: HTMLVideoElement) => video.pause());
    const creator = await popup(first, a, creatorId, config.backendGeneration);
    const sessionA = await frameOf(a);
    const targetA = new URL(sessionA.url()).hash.slice(1);
    await expect.poll(async () => (await creator.request(targetA)).connected).toBe(true);
    await expect.poll(() => creator.evaluate<boolean>(
      "Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Смотреть вместе' && !button.disabled)",
    )).toBe(true);
    await creator.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await creator.request(targetA)).invitation).toBe(true);
    const invitation = new URL((await creator.request(targetA)).invitation!);
    await creator.close();
    expect(invitation.origin).toBe(new URL(config.invitationBaseUrl).origin);
    expect(new URLSearchParams(invitation.hash.slice(1)).get('generation')).toBe(config.backendGeneration);
    const page = await second.newPage();
    const response = await page.goto(invitation.href);
    expect(response?.ok()).toBe(true);
    const headers = await response!.allHeaders();
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    await expect(page.locator('#installation')).toBeHidden();
    evidence.control = true;
    const join = () => page.frames().find(frame => frame.url().includes('/invitation.html#'));
    await expect.poll(join).toBeTruthy();
    await join()!.getByRole('button', { name: 'Присоединиться' }).press('Enter');
    await expect(join()!.locator('#status')).toContainText('Комната открыта');
    const guestPage = () => second.pages().find(candidate => candidate.url() === watch);
    await expect.poll(guestPage).toBeTruthy();
    const b = guestPage()!;
    const sessionB = await frameOf(b);
    await expect(sessionB.getByRole('listitem')).toHaveCount(2);
    await readyPlayer(b);
    evidence.join = true;
    expect(evidence.auth).toBe(true);
    expect(evidence.rest).toBe(true);
    const guest = await popup(second, b, guestId, config.backendGeneration);
    const targetB = new URL(sessionB.url()).hash.slice(1);
    const playback = async () => {
      const state = await guest.request(targetB);
      const room = state.room as { playback?: unknown; metadata?: { backendGeneration?: string } } | null;
      expect(room?.metadata?.backendGeneration).toBe(config.backendGeneration);
      return playbackSchema.parse(room?.playback);
    };
    const before = (await playback()).revision;
    await a.bringToFront();
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await playback()).revision).toBe(before + 1);
    await a.waitForTimeout(1000);
    expect((await playback()).revision).toBe(before + 1);
    evidence.command = true;
    await guest.request(targetB, 'stop');
    await expect.poll(async () => (await guest.request(targetB)).connected).toBe(false);
    await guest.request(targetB, 'retry');
    await expect.poll(async () => (await guest.request(targetB)).roomReady).toBe(true);
    expect((await playback()).revision).toBe(before + 1);
    evidence.recovery = true;
    await guest.close();
    expect(evidence.foreign).toBe(0);
  } finally {
    console.log('QA generation smoke', JSON.stringify(evidence));
    await second.close();
    await first.close();
  }
});
