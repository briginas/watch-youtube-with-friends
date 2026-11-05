import { test, expect } from '@playwright/test';
import { frameOf } from './fixtures';
import { sample, withPlaybackPair as pair } from './playback-fixture';


for (const remoteChange of [false, true]) {
  test(`offline до записи: локальные действия без очереди, reconnect ${remoteChange ? 'с новой' : 'с прежней'} revision`, async () => {
    let disconnected = false;
    let reading = false;
    let gateRead = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sockets = new Set<() => Promise<void>>();
    await pair(async ({ a, b, room }) => {
      const session = await frameOf(b);
      const before = (await room()).playback;
      disconnected = true;
      await b.context().setOffline(true);
      await Promise.all([...sockets].map(close => close()));
      await expect(session.locator('[role="status"]')).toContainText('Нет связи с сервером.');
      await b.locator('.ytp-play-button').click();
      await b.locator('.ytp-variable-speed-panel-button').click();
      await b.locator('.ytp-progress-bar').click();
      await b.waitForTimeout(400);
      expect((await room()).playback).toEqual(before);
      if (remoteChange) {
        await a.locator('.ytp-variable-speed-panel-button').click();
        await expect.poll(async () => (await room()).playback.revision).toBe(1);
        await a.locator('#movie_player').focus();
        await a.keyboard.press('ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(2);
      }
      const latest = (await room()).playback;
      // WebSocket уже online, но до завершения server read sync ещё запрещён.
      try {
        gateRead = true;
        disconnected = false;
        await b.context().setOffline(false);
        await expect.poll(() => reading).toBe(true);
        await expect(session.locator('[role="status"]')).toHaveText('Получаем актуальное состояние комнаты…');
        expect(await sample(b)).toMatchObject({ isPlaying: true, playbackRate: 1.5 });
        await b.locator('.ytp-variable-speed-panel-button').click();
        await b.waitForTimeout(300);
        expect((await room()).playback).toEqual(latest);
      } finally { release(); }
      await expect(session.locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/);
      await expect.poll(() => sample(b)).toMatchObject({
        isPlaying: latest.isPlaying, playbackRate: latest.playbackRate, positionSeconds: latest.positionSeconds,
      });
      await b.waitForTimeout(700);
      expect((await room()).playback).toEqual(latest);
      await b.locator('.ytp-variable-speed-panel-button').click();
      await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
    }, async context => {
      await context.route(/http:\/\/127\.0\.0\.1:9000\/rooms\/.*\.json/, async route => {
        if (gateRead) { reading = true; await gate; }
        await route.continue().catch(() => {});
      });
      await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
        if (disconnected) { void ws.close(); return; }
        const server = ws.connectToServer();
        const close = async () => { await Promise.all([ws.close(), server.close()]); };
        sockets.add(close);
        ws.onClose(() => { sockets.delete(close); void server.close(); });
        server.onClose(() => { sockets.delete(close); void ws.close(); });
        ws.onMessage(message => server.send(message));
      });
    });
  });
}

for (const cut of ['before-server', 'before-ack'] as const) for (const remoteChange of [false, true]) {
  test(`обрыв во время транзакции ${cut}: без replay ${remoteChange ? 'после команды другого UID' : 'без новых команд'}`, async () => {
    let armed = false;
    let disconnected = false;
    let intercepted = false;
    let writes = 0;
    await pair(async ({ a, b, room }) => {
      const session = await frameOf(b);
      armed = true;
      await b.locator('.ytp-variable-speed-panel-button').click();
      await expect.poll(() => intercepted).toBe(true);
      await expect(session.locator('[role="status"]')).toContainText('Нет связи с сервером.');
      const interrupted = (await room()).playback;
      expect(interrupted.revision).toBe(cut === 'before-server' ? 0 : 1);
      expect(writes).toBe(1);
      if (remoteChange) {
        await a.locator('#movie_player').focus();
        await a.keyboard.press('ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(interrupted.revision + 1);
      }
      const latest = (await room()).playback;
      if (remoteChange) expect(latest.actorUid === interrupted.actorUid).toBe(cut === 'before-server');
      // Любые действия отключённого клиента остаются локальными.
      await b.locator('.ytp-variable-speed-panel-button').click();
      await b.waitForTimeout(300);
      expect(writes).toBe(1);
      disconnected = false;
      await expect(session.locator('[role="status"]')).toHaveText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/, { timeout: 30_000 });
      await expect.poll(() => sample(b)).toMatchObject({
        positionSeconds: latest.positionSeconds, isPlaying: latest.isPlaying, playbackRate: latest.playbackRate,
      });
      await b.waitForTimeout(700);
      expect((await room()).playback).toEqual(latest);
      expect(writes).toBe(1);
      await b.locator('.ytp-variable-speed-panel-button').click();
      await expect.poll(async () => (await room()).playback.revision).toBe(latest.revision + 1);
      expect(writes).toBe(2);
    }, async context => {
      // Только сеть: настоящий SDK, Auth, RTDB и Rules. Ни одна команда
      // не подменяется; перехват разрывает конкретный пакет или его ack.
      await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
        if (disconnected) { void ws.close(); return; }
        const server = ws.connectToServer();
        let request: number | undefined;
        const close = () => {
          disconnected = true;
          intercepted = true;
          void ws.close();
          void server.close();
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
            close();
            return;
          }
          ws.send(message);
        });
      });
    });
  });
}
