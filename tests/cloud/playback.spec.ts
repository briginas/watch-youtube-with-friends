import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launchExtension } from '../e2e/fixtures';
import { frameOf, popup, watch, workerOf } from '../room-transport/fixtures';
import { playerFixture, readyPlayer } from '../room-transport/playback-fixture';
import { firebaseSettings } from '../../src/lib/firebase/settings';
import type { TransportState } from '../../src/lib/room/transport';
import { playbackSchema } from '../../src/lib/playback/model';
import { applicationTime, arm, percentile95, positionDifference } from './measurement';
import { observeMedia } from './diagnostics';

declare const chrome: typeof browserApi;

test('≥32 команды: задержка применения и позиции через 3 секунды', async ({}, testInfo) => {
  const config = firebaseSettings(process.env);
  if (!config) throw new Error('Нужна конфигурация Firebase. См. docs/experiments/cloud-measurement.md.');
  const rehearsal = config.emulators;
  const live = !rehearsal;
  const headless = process.env.CLOUD_HEADLESS !== '0';
  for (const name of ['CLOUD_FIREBASE_REGION', 'CLOUD_CLIENT_LOCATION', 'CLOUD_NETWORK']) {
    if (live && !process.env[name]?.trim()) throw new Error(`Укажите условия замера: ${name}`);
  }
  const path = resolve(rehearsal ? '.output/room-transport/chrome-mv3' : '.output/cloud/chrome-mv3');
  const contexts: BrowserContext[] = [];
  const watchPages: Page[] = [];
  const mediaEvents: Record<string, unknown>[][] = [];
  const observations: Record<string, unknown>[] = [];
  let stage = 'launch';
  let distinctUids = false;
  const browserVersions: string[] = [];
  const startedAt = new Date().toISOString();
  try {
    for (let index = 0; index < 2; index++) {
      const context = await launchExtension(path, [], headless);
      contexts.push(context);
      mediaEvents.push(await observeMedia(context));
      if (!live) await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: playerFixture() }));
      browserVersions.push(context.browser()!.version());
    }
    const [first, second] = contexts;
    const extensionIds = await Promise.all(contexts.map(async context => new URL((await workerOf(context)).url()).host));
    const a = await first!.newPage();
    watchPages.push(a);
    const videoUrl = process.env.CLOUD_VIDEO_URL ?? watch;
    await a.goto(videoUrl, { waitUntil: 'domcontentloaded' });
    await readyPlayer(a);
    await a.locator('#movie_player video.html5-main-video').first().evaluate((video: HTMLVideoElement) => {
      video.pause(); video.playbackRate = 1; video.currentTime = 5;
    });
    await readyPlayer(a);
    stage = 'create';
    const create = await popup(first!, a, extensionIds[0]!, config.backendGeneration);
    const sessionA = await frameOf(a);
    const targetA = new URL(sessionA.url()).hash.slice(1);
    await expect.poll(async () => (await create.request(targetA)).connected).toBe(true);
    await expect.poll(() => create.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
    await create.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
    await expect.poll(async () => !!(await create.request(targetA)).invitation).toBe(true);
    const created = await create.request(targetA);
    const invitation = created.invitation!;
    await create.close();
    stage = 'join';
    const invitationPage = await second!.newPage();
    await invitationPage.goto(invitation);
    await expect.poll(() => invitationPage.frames().some(frame => frame.url().includes('/invitation.html#'))).toBe(true);
    const invitationFrame = invitationPage.frames().find(frame => frame.url().includes('/invitation.html#'))!;
    const opened = second!.waitForEvent('page');
    await invitationFrame.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    watchPages.push(b);
    const sessionB = await frameOf(b);
    await expect(sessionB.getByRole('listitem')).toHaveCount(2);
    await invitationPage.close();
    await readyPlayer(b);
    await expect.poll(() => b.locator('video.html5-main-video').first().evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 5))).toBeLessThan(0.5);

    // Эти документы посылают существующий строго проверяемый popup API.
    // Во время измерения они лишь читают статус; общие команды идут через UI плеера.
    const drivers: Page[] = [];
    for (let index = 0; index < 2; index++) {
      const driver = await contexts[index]!.newPage();
      await driver.goto(`chrome-extension://${extensionIds[index]}/popup.html`);
      drivers.push(driver);
    }
    const targets = [targetA, new URL(sessionB.url()).hash.slice(1)];
    const status = (index: number) => drivers[index]!.evaluate(async ({ target, backendGeneration }) => {
      return chrome.runtime.sendMessage({ type: 'room-session', backendGeneration, target, action: 'status' }) as Promise<TransportState>;
    }, { target: targets[index]!, backendGeneration: config.backendGeneration });
    const initial = await Promise.all([status(0), status(1)]);
    const uids = initial.map(value => value.uid);
    distinctUids = !!uids[0] && !!uids[1] && uids[0] !== uids[1];
    expect(distinctUids).toBe(true);
    await expect.poll(async () => (await status(1)).roomReady).toBe(true);
    await a.waitForTimeout(500);

    let revision = 0;
    const actions = ['play', 'rate-up', 'seek-forward', 'pause', 'seek-back', 'rate-normal', 'play', 'pause'] as const;
    for (let round = 0; round < 16; round++) {
      if (round >= 4 && observations.filter(value => value.eligible).length >= 30) break;
      const sourceIndex = round % 2;
      const source = sourceIndex === 0 ? a : b;
      const remote = sourceIndex === 0 ? b : a;
      for (const action of actions) {
        stage = `command ${revision + 1}: ${sourceIndex + 1} ${action}`;
        await source.bringToFront();
        await readyPlayer(source);
        await readyPlayer(remote);
        const rate = action === 'rate-up' ? 1.25 : 1;
        if (action.startsWith('rate') && live) {
          await source.locator('.ytp-settings-button').click();
          await source.locator('.ytp-menuitem').filter({ hasText: 'Playback speed' }).click();
        } else await source.locator('#movie_player').focus();
        const event = action.startsWith('rate') ? 'ratechange' : action.startsWith('seek') ? 'seeking' : action;
        await Promise.all([arm(source, event), arm(remote)]);
        if (action.startsWith('rate') && live) {
          const presets = source.locator('.ytp-variable-speed-panel-preset-button');
          await presets.first().waitFor({ state: 'visible' });
          const labels = await presets.allTextContents();
          const expected = rate === 1 ? /^(?:1(?:\.0)?|Normal)$/ : /^1\.25$/;
          const selected = presets.filter({ hasText: expected });
          if (await selected.count() !== 1) throw new Error(`Пункт скорости ${rate} не найден; доступно: ${labels.join(', ')}`);
          await selected.click();
        } else if (action.startsWith('rate')) {
          // На стенде есть trusted keyboard '>'; для возврата скорости нужен UI-контрол.
          await source.keyboard.press(action === 'rate-up' ? 'Shift+Period' : 'Shift+Comma');
        } else await source.keyboard.press(action.startsWith('seek') ? action === 'seek-forward' ? 'ArrowRight' : 'ArrowLeft' : 'k');

        await expect.poll(() => source.evaluate(() => !!window.__cloudMeasurement?.changed), { timeout: 10_000 }).toBe(true);
        const signal = await source.evaluate(() => ({ inputAt: window.__cloudMeasurement!.inputAt!, changed: window.__cloudMeasurement!.changed! }));
        // Оба browser timer снимают позиции относительно одного момента команды,
        // независимо от времени ответа RTDB и опроса драйвера.
        const take = (page: Page) => page.evaluate(async inputAt => {
          await new Promise(resolveValue => setTimeout(resolveValue, Math.max(0, inputAt + 3100 - (performance.timeOrigin + performance.now()))));
          const points = window.__cloudMeasurement!.points;
          return { points, at3s: points.find(point => point.at >= inputAt + 3000) ?? null };
        }, signal.inputAt);
        const [sourceProbe, remoteProbe] = await Promise.all([take(source), take(remote)]);
        const at3s = [sourceProbe.at3s, remoteProbe.at3s];
        expect(at3s.every(Boolean)).toBe(true);
        const samples = [...sourceProbe.points, ...remoteProbe.points].filter(point => point.at >= signal.inputAt && point.at <= signal.inputAt + 3000);
        const sampleTimingValid = at3s.every(point => point!.at - signal.inputAt <= 3050);
        const eligible = sampleTimingValid && samples.length > 0 && samples.every(point => !point.ad && !point.buffering) && at3s.every(point => point!.ready);
        const latencyMs = applicationTime(remoteProbe.points, signal.inputAt, signal.changed);
        const differenceSeconds = positionDifference(at3s[0]!, at3s[1]!);
        revision++;
        const states = await Promise.all([status(0), status(1)]);
        const accepted = states.every(state => {
          const room = state.room as { playback?: unknown; metadata?: { backendGeneration?: string } } | null;
          const playback = playbackSchema.safeParse(room?.playback);
          return room?.metadata?.backendGeneration === config.backendGeneration &&
            playback.success && playback.data.revision === revision && playback.data.actorUid === uids[sourceIndex];
        });
        observations.push({ revision, source: sourceIndex + 1, action, eligible, latencyMs, differenceSeconds, sampleTimingValid,
          sampleDelayMs: at3s.map(point => point!.at - signal.inputAt),
          samplingSkewMs: Math.abs(at3s[0]!.at - at3s[1]!.at),
          samplesAt3s: at3s, acceptedOnce: accepted,
          buffering: samples.some(point => point.buffering), ad: samples.some(point => point.ad) });
        expect(accepted).toBe(true);
        if (action.startsWith('rate') && live) await source.keyboard.press('Escape');
        process.stdout.write(`command ${revision}: ${action}, ${eligible ? 'ready' : 'local restriction'}, ${latencyMs === null ? 'not applied' : `${Math.round(latencyMs)} ms`}, delta=${differenceSeconds.toFixed(3)} s; eligible=${observations.filter(value => value.eligible).length}\n`);
      }
    }
    stage = 'complete';
  } finally {
    const diagnostics = await Promise.all(watchPages.map(async page => {
      try {
        return await page.evaluate(() => ({
          videoId: new URL(location.href).searchParams.get('v'),
          visibility: document.visibilityState,
          playerClasses: document.querySelector('#movie_player')?.className ?? null,
          playability: (() => {
            const player = document.querySelector('#movie_player') as (Element & {
              getPlayerResponse?: () => { playabilityStatus?: { status?: string; reason?: string } };
            }) | null;
            const value = player?.getPlayerResponse?.().playabilityStatus;
            return value ? { status: value.status, reason: value.reason } : null;
          })(),
          players: [...document.querySelectorAll<HTMLVideoElement>('#movie_player video.html5-main-video')].map(video => ({
            readyState: video.readyState, networkState: video.networkState, position: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : null, sourcePresent: !!video.currentSrc,
            paused: video.paused, errorCode: video.error?.code ?? null,
            ad: !!video.closest('.ad-showing, .ad-interrupting'),
          })),
          error: document.querySelector<HTMLElement>('yt-playability-error-supported-renderers')?.innerText.slice(0, 500) ?? null,
        }));
      } catch { return { pageClosed: true }; }
    }));
    const eligible = observations.filter(value => value.eligible);
    const latencies = eligible.flatMap(value => typeof value.latencyMs === 'number' ? [value.latencyMs] : []);
    // Не теряем неприменённые команды при расчёте успешности всей выборки.
    const p95Ms = latencies.length === eligible.length ? percentile95(latencies) : null;
    const differences = eligible.map(value => value.differenceSeconds as number);
    const report = {
      startedAt, finishedAt: new Date().toISOString(), stage, rehearsal, liveYouTube: live,
      browserVersions, distinctUids,
      environment: { projectId: config.projectId, databaseHost: new URL(config.databaseURL).host, headless,
        region: process.env.CLOUD_FIREBASE_REGION ?? 'local emulator',
        clients: process.env.CLOUD_CLIENT_LOCATION ?? 'two independent profiles on one host',
        network: process.env.CLOUD_NETWORK ?? 'loopback', video: process.env.CLOUD_VIDEO_URL ?? watch },
      methodology: { minimumCommands: 32, minimumEligible: 30, maximumCommands: 128, samplingPeriodMs: 10, stableApplicationMs: 100,
        timing: 'trusted input to remote media matching source, stable for 100ms; browser monotonic clocks with shared host epoch',
        position: 'first samples at input+3000ms, extrapolated to common sample time',
        percentile: 'nearest rank ceil(0.95*N)', eligibility: 'no ads/readyState<3 during first 3s, both players ready at sample' },
      summary: { collected: observations.length, eligible: eligible.length, applied: latencies.length, p95Ms,
        maxDifferenceSeconds: differences.length ? Math.max(...differences) : null,
        meetsLatencyTarget: !rehearsal && latencies.length >= 30 && p95Ms !== null && p95Ms <= 1000,
        meetsPositionTarget: !rehearsal && differences.length >= 30 && differences.every(value => value <= 0.5) },
      observations,
      diagnostics,
      mediaEvents,
    };
    const output = testInfo.outputPath('measurements.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach('measurements', { path: output, contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close()));
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  }
});
