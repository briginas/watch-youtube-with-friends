import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test';
import { launchExtension } from '../e2e/fixtures';
import type { ProbeState } from '../../experiments/firebase-context/client';

const hosting = 'http://127.0.0.1:5002';
type DocumentContext = Page | Frame;
type StatusContext = { evaluate(fn: () => ProbeState): Promise<ProbeState> };

async function workerOf(context: BrowserContext) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
}

async function session(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(hosting);
  // Управляемый stand: нет передачи Auth или команд через postMessage.
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }, `chrome-extension://${extensionId}/session.html`);
  const iframe = page.frameLocator('iframe');
  await expect(iframe.getByText('Локальная проверка контекста Firebase.')).toBeVisible();
  const frame = page.frames().find((candidate) => candidate.url().includes('/session.html'))!;
  await frame.waitForFunction(() => !!globalThis.firebaseProbe);
  return { page, frame };
}

async function state(document: StatusContext): Promise<ProbeState> {
  return document.evaluate(() => firebaseProbe.status());
}

async function receive(document: DocumentContext | Worker, uid: string, value: string) {
  await expect.poll(async () => (await state(document)).values[uid]?.value).toBe(value);
  expect((await state(document)).error).toBeNull();
  expect((await state(document)).cspViolations).toEqual([]);
}

async function stopWorker(context: BrowserContext, page: Page, worker: Worker) {
  // Принудительная остановка, а не ожидание idle при подключённом debugger.
  const cdp = await context.newCDPSession(page);
  let versionId: string | undefined;
  let runningStatus: string | undefined;
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const match = versions.find((item: { scriptURL: string; status: string }) =>
      item.scriptURL === worker.url() && item.status === 'activated');
    if (match) {
      versionId = match.versionId;
      runningStatus = match.runningStatus;
    }
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versionId).toBeTruthy();
  await cdp.send('ServiceWorker.stopWorker', { versionId: versionId! });
  // Playwright сохраняет Worker object при MV3 suspension; close не испускается.
  await expect.poll(() => runningStatus).toBe('stopped');
  await cdp.detach();
}

test('документы переживают закрытие настоящего popup и worker; worker восстанавливает актуальные данные', async ({}, testInfo) => {
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  const blocked: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const context = await launchExtension(resolve('.output/firebase-context/chrome-mv3'));
      contexts.push(context);
      context.on('page', (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
      });
      context.on('request', (request) => {
        const url = new URL(request.url());
        if (/^(https?|wss?):$/.test(url.protocol) && url.hostname !== '127.0.0.1') {
          blocked.push(url.origin);
        }
      });
      // Non-loopback HTTP(S) блокируется; WebSocket ограничен connect-src CSP.
      await context.route(/https?:\/\//, async (route) => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') {
          blocked.push(new URL(route.request().url()).origin);
          return route.abort();
        }
        return route.continue();
      });
    }
    const first = contexts[0]!;
    const second = contexts[1]!;
    let worker = await workerOf(first);
    const extensionId = new URL(worker.url()).host;
    const secondId = new URL((await workerOf(second)).url()).host;
    const probeId = randomUUID();
    const [a, b, observer] = await Promise.all([
      session(first, extensionId), session(first, extensionId), session(second, secondId),
    ]);
    // Fresh profile: гонка двух iframe и worker до первого sign-in.
    const [aState, bState, workerState, observerState] = await Promise.all([
      a.frame.evaluate((id) => firebaseProbe.start(id), probeId),
      b.frame.evaluate((id) => firebaseProbe.start(id), probeId),
      worker.evaluate((id) => firebaseProbe.start(id), probeId),
      observer.frame.evaluate((id) => firebaseProbe.start(id), probeId),
    ]);
    const uid = aState.uid!;
    const observerUid = observerState.uid!;
    expect(uid).toBeTruthy();
    expect(bState.uid).toBe(uid);
    expect(workerState.uid).toBe(uid);
    expect(observerUid).not.toBe(uid);
    await a.frame.evaluate(() => firebaseProbe.write('initial'));
    await Promise.all([receive(b.frame, uid, 'initial'), receive(observer.frame, uid, 'initial')]);

    // Настоящий action popup, не popup.html в обычной вкладке.
    const popupState = await worker.evaluate((id) => openProbePopup(id), probeId);
    expect(await worker.evaluate(() => probePopupCount())).toBe(1);
    expect(popupState.uid).toBe(uid);
    expect(popupState.connected).toBe(true);
    expect(popupState.values[uid]?.value).toBe('initial');
    expect(popupState.cspViolations).toEqual([]);
    await worker.evaluate(() => closeProbePopup());
    await expect.poll(() => worker.evaluate(() => probePopupCount())).toBe(0);
    await observer.frame.evaluate(() => firebaseProbe.write('after-popup'));
    await Promise.all([receive(a.frame, observerUid, 'after-popup'), receive(b.frame, observerUid, 'after-popup')]);

    await stopWorker(first, a.page, worker);
    await observer.frame.evaluate(() => firebaseProbe.write('after-worker-stop'));
    await Promise.all([receive(a.frame, observerUid, 'after-worker-stop'), receive(b.frame, observerUid, 'after-worker-stop')]);
    // Runtime message из extension page будит worker; данные читаются с сервера.
    const control = await first.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    await control.waitForFunction(() => !!globalThis.wakeProbeWorker);
    const restarted = await control.evaluate((id) => wakeProbeWorker(id), probeId);
    expect(restarted.uid).toBe(uid);
    expect(restarted.instance).not.toBe(workerState.instance);
    worker = await workerOf(first);
    await receive(worker, observerUid, 'after-worker-stop');

    // Повторная загрузка frame сохраняет UID и получает последнюю версию.
    await a.frame.goto(`chrome-extension://${extensionId}/session.html`);
    await a.frame.waitForFunction(() => !!globalThis.firebaseProbe);
    expect((await a.frame.evaluate((id) => firebaseProbe.start(id), probeId)).uid).toBe(uid);
    await receive(a.frame, observerUid, 'after-worker-stop');
    await a.page.close();
    await observer.frame.evaluate(() => firebaseProbe.write('one-tab-left'));
    await receive(b.frame, observerUid, 'one-tab-left');

    // Worker как единственный владелец: остановка оставляет интервал без подписки.
    await b.page.close();
    await control.close();
    const driver = await first.newPage();
    await driver.goto(hosting);
    await stopWorker(first, driver, worker);
    await observer.frame.evaluate(() => firebaseProbe.write('while-worker-stopped'));
    const recovery = await first.newPage();
    await recovery.goto(`chrome-extension://${extensionId}/popup.html`);
    await recovery.waitForFunction(() => !!globalThis.wakeProbeWorker);
    const recovered = await recovery.evaluate((id) => wakeProbeWorker(id), probeId);
    expect(recovered.uid).toBe(uid);
    expect(recovered.instance).not.toBe(restarted.instance);
    worker = await workerOf(first);
    await receive(worker, observerUid, 'while-worker-stopped');
    await worker.evaluate(() => firebaseProbe.write('worker-recovered'));
    await receive(observer.frame, uid, 'worker-recovered');
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    const matrixPath = testInfo.outputPath('context-matrix.json');
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(matrixPath, JSON.stringify({
        browser: first.browser()?.version(), sameUidAcrossFramesWorkerPopup: true,
        independentProfileUid: true, popupClosed: true, workerStoppedTwice: true,
        documentUpdatesWhileWorkerStopped: true, reloadAndTabClose: true,
        workerRecoveredLatestState: true, cspOrPageErrors: errors, externalOrigins: blocked,
      }, null, 2));
    await testInfo.attach('context-matrix', {
      path: matrixPath,
      contentType: 'application/json',
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
