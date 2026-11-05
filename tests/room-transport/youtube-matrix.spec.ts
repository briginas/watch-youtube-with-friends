import { test, expect } from '@playwright/test';
import { frameOf, popup, stopWorker } from './fixtures';
import { readyPlayer, sample } from './playback-fixture';
import { converged, livePair, seek } from './youtube-matrix-fixture';

test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
test.setTimeout(240_000);
test.use({ trace: 'off' });

test('YouTube matrix: popup, остановка worker, reload и сохранение UID', async ({}, testInfo) => {
  await livePair(testInfo, async ({ first, second, a, b, room, guestUid, record }) => {
    const initial = (await room()).playback;
    // Popup обоих профилей уже закрыты; останавливаем оба worker через CDP.
    const stoppedA = await stopWorker(first.context, a, first.worker);
    const stoppedB = await stopWorker(second.context, b, second.worker);
    try {
      await seek(a, 'ArrowRight');
      await expect.poll(async () => (await room()).playback.revision).toBe(initial.revision + 1);
      await converged(a, b, (await room()).playback);
      await seek(b, 'ArrowLeft');
      await expect.poll(async () => (await room()).playback.revision).toBe(initial.revision + 2);
      expect((await room()).playback.actorUid === guestUid).toBe(true);
      await converged(a, b, (await room()).playback);
      await b.waitForTimeout(700);
      expect((await room()).playback.revision).toBe(initial.revision + 2);
      await record('bidirectional sync with stopped workers');
    } finally {
      await stoppedA.detach(); await stoppedB.detach();
    }
    const latest = (await room()).playback;
    await b.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await frameOf(b);
    await expect(reloaded.locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/);
    await converged(a, b, latest);
    const control = await popup(second.context, b, second.extensionId);
    expect((await control.request(new URL(reloaded.url()).hash.slice(1))).uid === guestUid).toBe(true);
    await control.close();
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    await b.waitForTimeout(700);
    expect((await room()).playback).toEqual(latest);
    await record('reload: same UID and latest revision, no echo');
    await seek(b, 'ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
    await converged(a, b, (await room()).playback);
    await record('guest controls after reload');
  });
});

test('YouTube matrix: SPA-навигация локальна, возврат применяет последнюю revision', async ({}, testInfo) => {
  await livePair(testInfo, async ({ a, b, room, record }) => {
    const initial = (await room()).playback;
    const marker = await b.evaluate(() => {
      const value = crypto.randomUUID(); document.documentElement.dataset.matrixDocument = value; return value;
    });
    const link = b.locator(`a[href^="/watch?v="]:not([href*="${initial.videoId}"]):visible`).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    const next = new URL((await link.getAttribute('href'))!, b.url()).searchParams.get('v');
    await link.press('Enter');
    await expect.poll(() => new URL(b.url()).searchParams.get('v')).toBe(next);
    expect(await b.evaluate(() => document.documentElement.dataset.matrixDocument)).toBe(marker);
    const sessionB = await frameOf(b);
    await expect(sessionB.locator('#player-status')).toContainText('Не синхронизируется');
    await b.waitForTimeout(1800);
    expect((await room()).playback).toEqual(initial);
    await record('SPA: other video stays local', { sameDocument: true, otherVideoId: next });
    await seek(a, 'ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(initial.revision + 1);
    const latest = (await room()).playback;
    expect(latest.videoId).toBe(initial.videoId);
    await expect(sessionB.getByRole('link', { name: 'Вернуться в комнату' })).toHaveAttribute('href',
      `https://www.youtube.com/watch?v=${initial.videoId}`);
    await sessionB.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect.poll(() => new URL(b.url()).searchParams.get('v')).toBe(initial.videoId);
    await converged(a, b, latest);
    await b.waitForTimeout(1800);
    expect((await room()).playback).toEqual(latest);
    await record('return to shared video: latest revision, no echo');
  });
});

test('YouTube matrix: более позднее действие побеждает из одной revision', async ({}, testInfo) => {
  let armed = false;
  const captured: { revision: number; actionAt: number; positionSeconds: number }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await livePair(testInfo, async ({ a, b, room, guestUid, record }) => {
      const initial = (await room()).playback;
      armed = true;
      await seek(a, 'ArrowRight');
      await expect.poll(() => captured.length).toBe(1);
      await seek(b, 'ArrowLeft');
      await expect.poll(() => captured.length).toBe(2);
      expect(captured.map(command => command.revision)).toEqual([initial.revision + 1, initial.revision + 1]);
      expect(captured[1]!.actionAt).toBeGreaterThan(captured[0]!.actionAt);
      armed = false;
      release();
      await expect.poll(async () => (await room()).playback.actionAt).toBe(captured[1]!.actionAt);
      const accepted = (await room()).playback;
      expect(accepted.actorUid).toBe(guestUid);
      expect(accepted.revision).toBeGreaterThanOrEqual(initial.revision + 1);
      expect(accepted.revision).toBeLessThanOrEqual(initial.revision + 2);
      expect(Math.abs(accepted.positionSeconds - captured[1]!.positionSeconds)).toBeLessThan(0.5);
      await converged(a, b, accepted);
      await b.waitForTimeout(1800);
      expect((await room()).playback).toEqual(accepted);
      await record('later user action wins from the same base revision, no replay', {
        bothCommandsBasedOnSameRevision: true, acceptedSource: 'guest',
      });
    }, async context => {
      await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
        const server = ws.connectToServer();
        ws.onMessage(message => {
          const packet = JSON.parse(message.toString());
          if (armed && packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
            const { revision, actionAt, positionSeconds } = packet.d.b.d;
            captured.push({ revision, actionAt, positionSeconds });
            void gate.then(() => server.send(message));
          } else server.send(message);
        });
      });
    });
  } finally { release(); }
});

test('YouTube matrix: offline-действия не переигрываются после reconnect', async ({}, testInfo) => {
  let disconnected = false;
  const sockets = new Set<() => Promise<void>>();
  await livePair(testInfo, async ({ a, b, room, record }) => {
    const sessionB = await frameOf(b);
    const initial = (await room()).playback;
    disconnected = true;
    await b.context().setOffline(true);
    await Promise.all([...sockets].map(close => close()));
    await expect(sessionB.locator('[role="status"]')).toContainText('Просмотр остаётся локальным.');
    await b.locator('.ytp-play-button').click();
    await b.locator('#movie_player').focus();
    await b.keyboard.press('ArrowRight');
    await b.waitForTimeout(1800);
    expect((await room()).playback).toEqual(initial);
    await record('offline: local play and seek do not write');
    await seek(a, 'ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(initial.revision + 1);
    const latest = (await room()).playback;
    disconnected = false;
    await b.context().setOffline(false);
    await expect(sessionB.locator('[role="status"]')).toHaveText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/, { timeout: 45_000 });
    await converged(a, b, latest);
    await b.waitForTimeout(1800);
    expect((await room()).playback).toEqual(latest);
    await record('reconnect: latest remote state, no queued actions');
    await seek(b, 'ArrowLeft');
    await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
    await converged(a, b, (await room()).playback);
    await record('new guest action after reconnect');
  }, async (context, index) => {
    if (index !== 1) return;
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      if (disconnected) { void ws.close(); return; }
      const server = ws.connectToServer();
      const close = async () => { await Promise.all([ws.close(), server.close()]); };
      sockets.add(close);
      ws.onClose(() => { sockets.delete(close); void server.close(); });
      server.onClose(() => { sockets.delete(close); void ws.close(); });
    });
  });
});

test('YouTube matrix: настоящее buffering локально, восстановление последней revision', async ({}, testInfo) => {
  await livePair(testInfo, async ({ a, b, room, record }) => {
    const sessionB = await frameOf(b);
    const initial = (await room()).playback;
    const cdp = await b.context().newCDPSession(b);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    try {
      // Настоящая нехватка данных вне cache; media events и DOM не подменяются.
      await b.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => { v.currentTime = v.duration * 0.87; });
      await expect(sessionB.locator('.buffering-spinner')).toBeVisible({ timeout: 25_000 });
      await expect(sessionB.locator('#room-toggle')).toHaveAttribute('title', /Видео загружается/);
      expect((await room()).playback).toEqual(initial);
      await record('media network offline: buffering with connected RTDB');
      await seek(a, 'ArrowRight');
      await expect.poll(async () => (await room()).playback.revision).toBe(initial.revision + 1);
      const latest = (await room()).playback;
      expect((await sample(b)).positionSeconds).toBeGreaterThan(100);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      // Возвращаем настоящий плеер в загруженный диапазон: дальняя доставка
      // медиа может не восстановиться. Это явно отражено в наблюдениях.
      await b.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => { v.currentTime = 10; });
      await readyPlayer(b);
      await converged(a, b, latest);
      await expect(sessionB.locator('.buffering-spinner')).toBeHidden();
      await b.waitForTimeout(1800);
      expect((await room()).playback).toEqual(latest);
      await record('buffering recovered: latest revision without echo', { recovery: 'network restored, explicit local seek to cached 10s' });
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
    }
  });
});

for (const cut of ['before-server', 'before-ack'] as const) {
  test(`YouTube matrix: обрыв транзакции ${cut}, новое действие другого участника`, async ({}, testInfo) => {
    let armed = false;
    let disconnected = false;
    let intercepted = false;
    let writes = 0;
    await livePair(testInfo, async ({ a, b, room, record }) => {
      const sessionB = await frameOf(b);
      const initial = (await room()).playback;
      armed = true;
      await seek(b, 'ArrowRight');
      try {
        await expect.poll(() => writes).toBe(1);
        await expect.poll(() => intercepted).toBe(true);
      } finally { await record('transaction cut attempt', { cut, guestWrites: writes, intercepted }); }
      await expect(sessionB.locator('[role="status"]')).toContainText('Просмотр остаётся локальным.');
      const interrupted = (await room()).playback;
      expect(interrupted.revision).toBe(initial.revision + (cut === 'before-server' ? 0 : 1));
      expect(writes).toBe(1);
      await seek(a, 'ArrowRight');
      await expect.poll(async () => (await room()).playback.revision).toBe(interrupted.revision + 1);
      const latest = (await room()).playback;
      await record('interrupted transaction, newer remote command', { cut, guestWrites: writes });
      disconnected = false;
      await expect(sessionB.locator('[role="status"]')).toHaveText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/, { timeout: 45_000 });
      await converged(a, b, latest);
      await b.waitForTimeout(1800);
      expect((await room()).playback).toEqual(latest);
      expect(writes).toBe(1);
      await record('reconnect: no retry or rollback', { cut, guestWrites: writes });
      await seek(b, 'ArrowLeft');
      await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
      expect(writes).toBe(2);
      await converged(a, b, (await room()).playback);
      await record('new guest command accepted', { cut, guestWrites: writes });
    }, async (context, index) => {
      if (index !== 1) return;
      await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
        if (disconnected) { void ws.close(); return; }
        const server = ws.connectToServer();
        let request: number | undefined;
        const close = () => {
          disconnected = true; intercepted = true;
          void ws.close(); void server.close();
        };
        ws.onMessage(message => {
          const packet = JSON.parse(message.toString());
          if (packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
            writes++;
            if (armed) {
              armed = false;
              if (cut === 'before-server') { close(); return; }
              request = packet.d.r;
            }
          }
          server.send(message);
        });
        server.onMessage(message => {
          const packet = JSON.parse(message.toString());
          if (request !== undefined && packet?.d?.r === request) {
            expect(packet.d.b.s).toBe('ok');
            close(); return;
          }
          ws.send(message);
        });
      });
    });
  });
}
