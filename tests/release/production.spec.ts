import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchExtension } from '../e2e/fixtures';
import { frameOf, workerOf, popup, watch, openDetails } from '../room-transport/fixtures';
import { readyPlayer } from '../room-transport/playback-fixture';
import { playbackSchema } from '../../src/lib/playback/model';
import { releaseDescriptorSchema } from '../../src/lib/backend-generations';
import type { browser as browserApi } from 'wxt/browser';
import type { TransportState } from '../../src/lib/room/transport';

declare const chrome: typeof browserApi;

test('production: два профиля, приглашение, команда, выход создателя и повторное открытие', async () => {
  test.skip(process.env.RELEASE_SMOKE !== '1', 'Opt-in: создаёт настоящую production-комнату.');
  const info = JSON.parse(await readFile('.output/release/build-info.json', 'utf8'));
  const { backendGeneration } = releaseDescriptorSchema.parse(info.descriptor);
  const path = resolve('.output/release/chrome-mv3');
  const headless = process.env.RELEASE_HEADED !== '1';
  const first = await launchExtension(path, [], headless);
  const second = await launchExtension(path, [], headless);
  const startedAt = new Date().toISOString();
  const results: Record<string, unknown> = { startedAt, headless, environment: 'two isolated Chromium profiles on one Mac/network; actual YouTube and production Firebase' };
  let stage = 'launch';
  let diagnostics = async (): Promise<unknown> => null;
  try {
    await first.setDefaultTimeout(20_000); await second.setDefaultTimeout(20_000);
    const idA = new URL((await workerOf(first)).url()).host;
    const idB = new URL((await workerOf(second)).url()).host;
    const a = await first.newPage(); await a.setViewportSize({ width: 1280, height: 800 });
    stage = 'YouTube player readiness';
    await a.goto(watch, { waitUntil: 'domcontentloaded' }); await readyPlayer(a);
    await a.locator('video.html5-main-video').first().evaluate((video: HTMLVideoElement) => video.pause());
    stage = 'session frame';
    const control = await popup(first, a, idA, backendGeneration);
    const sessionA = await frameOf(a);
    const target = new URL(sessionA.url()).hash.slice(1);
    diagnostics = async () => {
      const state = await control.request(target);
      return { phase: state.phase, connected: state.connected, roomReady: state.roomReady,
        creationError: state.creationError, error: state.error,
        ui: await control.evaluate("Array.from(document.querySelectorAll('[role=status],[role=alert],button')).map(e=>({text:e.textContent,disabled:e.disabled}))") };
    };
    stage = 'Firebase connection';
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    stage = 'create';
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Смотреть вместе'&&!b.disabled)")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Смотреть вместе').click();true");
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const created = await control.request(target);
    const invitation = created.invitation!;
    await control.close(); results.created = true;
    stage = 'join';
    const invitationPage = await second.newPage(); await invitationPage.goto(invitation);
    await expect(invitationPage.locator('#installation')).toBeHidden();
    await expect(invitationPage.getByRole('link', { name: 'Политика конфиденциальности' })).toBeVisible();
    await expect.poll(() => invitationPage.frames().some(frame => frame.url().includes('/invitation.html#'))).toBe(true);
    const join = invitationPage.frames().find(frame => frame.url().includes('/invitation.html#'))!;
    const opened = second.waitForEvent('page'); await join.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened; await b.setViewportSize({ width: 1280, height: 800 }); await readyPlayer(b);
    const sessionB = await frameOf(b); await expect(sessionB.getByRole('listitem')).toHaveCount(2);
    diagnostics = async () => ({
      creatorStatus: await sessionA.locator('#status').textContent(),
      creatorAction: await sessionA.locator('#action-status').textContent(),
      guestStatus: await sessionB.locator('#status').textContent(),
      guestListItems: await sessionB.locator('li').count(),
      guestRoleItems: await sessionB.getByRole('listitem').count(),
      guestParticipantsHidden: await sessionB.locator('#participants').getAttribute('hidden'),
      clickDiagnostics: await sessionA.evaluate(() => ({
        clicks: (globalThis as typeof globalThis & { releaseClicks?: number }).releaseClicks,
        focused: document.activeElement?.id,
        disabled: document.querySelector<HTMLButtonElement>('#leave')?.disabled,
      })),
    });
    results.joined = true; await invitationPage.close();
    stage = 'command';
    const driver = await second.newPage(); await driver.goto(`chrome-extension://${idB}/popup.html`);
    const state = () => driver.evaluate(async ({ target, backendGeneration }) => chrome.runtime.sendMessage({ type: 'room-session', backendGeneration, action: 'status', target }) as Promise<TransportState>, { target: new URL(sessionB.url()).hash.slice(1), backendGeneration });
    const playback = async () => {
      const room = (await state()).room as { playback?: unknown; metadata?: { backendGeneration?: string } } | null;
      expect(room?.metadata?.backendGeneration).toBe(backendGeneration);
      return playbackSchema.parse(room?.playback);
    };
    const before = await playback();
    await a.bringToFront(); await a.locator('#movie_player').focus(); await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await playback()).revision).toBeGreaterThan(before.revision);
    results.sharedCommand = true;
    stage = 'screenshots';
    await mkdir('docs/store-assets', { recursive: true });
    await b.bringToFront();
    // Снимок viewport не содержит адресную строку. Приглашение в панели скрыто по умолчанию.
    await expect(sessionB.locator('#manual-invitation')).toBeHidden();
    await b.screenshot({ path: 'docs/store-assets/room-1280x800.png' });
    results.screenshot = 'docs/store-assets/room-1280x800.png';
    stage = 'creator panel';
    await a.bringToFront();
    await openDetails(sessionA);
    results.creatorPanel = { expanded: await sessionA.locator('#room-toggle').getAttribute('aria-expanded'),
      leaveVisible: await sessionA.locator('#leave').isVisible() };
    stage = 'creator leave click';
    await sessionA.evaluate(() => {
      (globalThis as typeof globalThis & { releaseClicks?: number }).releaseClicks = 0;
      document.querySelector('#leave')!.addEventListener('click', () => {
        const scope = globalThis as typeof globalThis & { releaseClicks?: number };
        scope.releaseClicks = (scope.releaseClicks ?? 0) + 1;
      }, { capture: true });
    });
    await sessionA.getByRole('button', { name: 'Выйти из комнаты', exact: true }).click();
    const clicks = await sessionA.evaluate(() => (globalThis as typeof globalThis & { releaseClicks?: number }).releaseClicks);
    results.leavePointerClicks = clicks;
    if (!clicks) {
      await sessionA.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
      results.leaveKeyboardFallback = true;
    }
    results.creatorAfterLeave = await sessionA.locator('#status').textContent();
    stage = 'creator presence removal';
    await b.bringToFront();
    await expect(sessionB.getByRole('listitem')).toHaveCount(1); results.creatorLeft = true;
    stage = 'reopen';
    await a.close();
    const catalog = await first.newPage(); await catalog.goto(`chrome-extension://${idA}/popup.html`);
    const reopened = first.waitForEvent('page');
    await catalog.getByRole('button', { name: 'Открыть', exact: true }).first().click();
    const aAgain = await reopened;
    const restored = await frameOf(aAgain); await expect(restored.getByRole('listitem')).toHaveCount(2);
    results.reopened = true; results.distinctProfiles = true; results.status = 'passed';
    await restored.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
    await sessionB.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
  } catch (error) {
    results.status = 'failed'; results.stage = stage;
    results.failure = error instanceof Error ? error.message.split('\n')[0]?.replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9_-]{24,}/g, '[value]') : 'unknown';
    results.diagnostics = await diagnostics().catch(() => null);
    const page = first.pages().find(page => page.url().startsWith('https://www.youtube.com/watch'));
    if (page) {
      results.media = await page.locator('video').evaluateAll(nodes => nodes.map(node => {
        const video = node as HTMLVideoElement;
        return {
        readyState: video.readyState, networkState: video.networkState,
        error: video.error?.code ?? null, paused: video.paused,
      }; })).catch(() => []);
      if (stage === 'YouTube player readiness') await page.screenshot({ path: '.output/release/smoke-readiness.png' });
    }
    throw new Error(`Production smoke failed at ${stage}; credentials omitted.`);
  } finally {
    await second.close(); await first.close();
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    const zip = await readFile(`.output/release/watch-together-${version}.zip`);
    await writeFile('.output/release/production-smoke.json', JSON.stringify({ ...results, version, zipSha256: createHash('sha256').update(zip).digest('hex') }, null, 2));
  }
});
