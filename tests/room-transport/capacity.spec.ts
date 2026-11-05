import { test, expect, type Page, type BrowserContext, type WebSocket } from '@playwright/test';
import { setup, admin, frameOf, popup, watch } from './fixtures';
function onSockets(context: BrowserContext, callback: (socket: WebSocket) => void) {
  for (const page of context.pages()) page.on('websocket', callback);
  context.on('page', page => page.on('websocket', callback));
}
const hosting = 'http://127.0.0.1:5002/';
const key = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const fixture = () => ({ metadata: { name: 'Capacity fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
  videoId: 'aqz-KE-bpKQ', positionSeconds: 0, playbackRate: 1, isPlaying: false, revision: 0, kind: 'playback', videoRevision: 0,
  actorUid: 'fixture', commandId: 'initial', updatedAt: 1, actionAt: 1, sampledAt: 1,
} });
async function invitation(page: Page, secret: string) {
  await page.goto(`${hosting}#generation=emulator-v1&room=${secret}`);
  await expect.poll(() => page.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
  const frame = page.frames().find(f => f.url().includes('/invitation.html#'))!;
  await expect(frame.locator('#join')).toBeEnabled(); return frame;
}
function status(state: string, extra = {}) {
  return { version: 1, state, updatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...extra };
}
test('статус через штатную CSP: unavailable не запускает Auth, busy даёт countdown/cancel, ручные клики throttled', async () => {
  for (const announced of [status('unavailable', { reason: 'quota' }), status('busy', { retryAfterSeconds: 60 })]) {
    const { context } = await setup();
    try {
      let statusRequests = 0, auth = 0, sockets = 0;
      await context.route(`${hosting}generations/emulator-v1/service-status.json`, route => { statusRequests++; return route.fulfill({ json: announced }); });
      context.on('request', r => { if (r.url().includes(':9099/')) auth++; });
      onSockets(context, () => sockets++);
      const page = await context.newPage(); const frame = await invitation(page, key());
      await frame.locator('#join').click();
      await expect(frame.locator('#status')).toContainText(announced.state === 'busy' ? 'Сервис перегружен' : 'Ресурсы сервиса временно исчерпаны');
      if (announced.state === 'busy') {
        await expect(frame.locator('#status')).toContainText('Следующая попытка через');
        await frame.locator('#cancel').press('Enter'); await expect(frame.locator('#status')).toContainText('Вход отменён');
      }
      await frame.locator('#join').click();
      await expect(frame.locator('#status')).toContainText(announced.state === 'busy' ? 'Сервис перегружен' : 'Ресурсы сервиса временно исчерпаны');
      expect(statusRequests).toBe(1); expect(auth).toBe(0); expect(sockets).toBe(0);
    } finally { await context.close(); }
  }
});
test('отмена read-only входа не открывает позднюю вкладку; HTTP read не создаёт WebSocket', async () => {
  const { context } = await setup();
  const secret = key(); await admin(`rooms/${secret}`, fixture());
  let release!: () => void; const gate = new Promise<void>(yes => { release = yes; });
  let reading = false, sockets = 0;
  try {
    onSockets(context, () => sockets++);
    await context.route(/http:\/\/127\.0\.0\.1:9000\/rooms\/.*\.json/, async route => { reading = true; await gate; await route.continue().catch(() => {}); });
    const page = await context.newPage(); const frame = await invitation(page, secret);
    await frame.locator('#join').press('Enter'); await expect.poll(() => reading).toBe(true);
    expect(sockets).toBe(0);
    await frame.locator('#cancel').press('Enter'); release();
    await expect(frame.locator('#status')).toContainText('Вход отменён');
    await page.waitForTimeout(500);
    expect(context.pages().some(p => p.url().startsWith(watch))).toBe(false); expect(sockets).toBe(0);
    const room = await fetch(`http://127.0.0.1:9000/rooms/${secret}.json?ns=demo-watch-together-default-rtdb`, { headers: { Authorization: 'Bearer owner' } }).then(r => r.json());
    expect(room.presence).toBeUndefined();
  } finally { release(); await context.close(); }
});
test('watch: один сокет, fresh REST/reconnect без второго; stop сохраняет binding и независимость popup', async () => {
  const { context, extensionId } = await setup();
  try {
    const page = await context.newPage(); await page.goto(watch);
    let live = 0, peak = 0, reads = 0;
    onSockets(context, ws => {
      if (!ws.url().includes(':9000/')) return;
      live++; peak = Math.max(peak, live); ws.on('close', () => live--);
    });
    context.on('request', r => { if (new URL(r.url()).pathname.startsWith('/rooms/') && new URL(r.url()).pathname.endsWith('.json')) reads++; });
    const control = await popup(context, page, extensionId);
    const frame = await frameOf(page); const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const created = await control.request(target, 'create', { playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 0, playbackRate: 1, isPlaying: false }, metadata: { name: 'Socket budget', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' } });
    expect(created.roomReady).toBe(true); expect(reads).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(1);
    const before = reads;
    await control.request(target, 'stop');
    await expect.poll(() => live).toBe(0); expect((await control.request(target)).room).not.toBeNull();
    const stored = await control.evaluate<Record<string, unknown>>('chrome.storage.session.get(null)');
    expect(JSON.stringify(stored)).toContain('Socket budget');
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Повторить')")).toBe(true);
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Повторить').click(); true");
    await expect.poll(async () => (await control.request(target)).roomReady).toBe(true);
    expect(reads).toBeGreaterThan(before); expect(peak).toBeLessThanOrEqual(1);
    await control.close(); await expect(frame.getByRole('listitem')).toHaveCount(1);
    const repeat = await context.newPage(); const repeated = await invitation(repeat, created.invitation!.split('room=')[1]!);
    const readBefore = reads; await repeated.locator('#join').press('Enter');
    await expect(repeated.locator('#status')).toContainText('Комната открыта'); expect(reads).toBe(readBefore); expect(peak).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});
test('потерянный ack создания: явный повтор проверяет прежний ключ и не создаёт дубликат', async () => {
  const { context, extensionId } = await setup();
  let armed = true, initialWrites = 0, intercepted = false;
  try {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, socket => {
      const server = socket.connectToServer(); let lostAck: number | undefined;
      socket.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (packet?.d?.a === 'p' && /^\/rooms\/[^/]+$/.test(packet.d.b?.p ?? '')) {
          initialWrites++;
          if (armed) { armed = false; lostAck = packet.d.r; }
        }
        server.send(message);
      });
      server.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (lostAck !== undefined && packet?.d?.r === lostAck) {
          intercepted = true; lostAck = undefined;
          // Сервер принял set, но SDK этого не узнаёт. Соединение остаётся
          // живым: не смешиваем потерю ack с автоматическим SDK replay set.
          return;
        }
        socket.send(message);
      });
    });
    const page = await context.newPage(); await page.goto(watch);
    const control = await popup(context, page, extensionId); const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const request = { type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'create', metadata: { name: 'Lost ack', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 0, playbackRate: 1, isPlaying: false } };
    await control.evaluate(`void chrome.runtime.sendMessage(${JSON.stringify(request)}); true`);
    await expect.poll(() => intercepted).toBe(true);
    await expect.poll(async () => (await control.request(target)).creationError, { timeout: 20_000 }).toContain('Результат создания пока неизвестен');
    expect((await control.request(target)).invitation).toBeNull(); expect(initialWrites).toBe(1);
    const resolved = await control.request(target, 'create', { metadata: { name: 'Lost ack', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: request.playback });
    expect(resolved.roomReady).toBe(true); expect(!!resolved.invitation).toBe(true); expect(initialWrites).toBe(1);
    await control.close();
  } finally { await context.close(); }
});
test('общие 15с включают зависший Auth; отмена не пропускает поздний ответ', async () => {
  const { context } = await setup();
  let release!: () => void; const gate = new Promise<void>(yes => { release = yes; }); let signingIn = false;
  try {
    await context.route('http://127.0.0.1:9099/**', async route => {
      if (route.request().url().includes('accounts:signUp')) { signingIn = true; await gate; }
      await route.continue().catch(() => {});
    });
    const page = await context.newPage(); const frame = await invitation(page, key());
    const started = Date.now(); await frame.locator('#join').press('Enter'); await expect.poll(() => signingIn).toBe(true);
    await expect(frame.locator('#status')).toContainText('Следующая попытка через', { timeout: 17_000 });
    expect(Date.now() - started).toBeLessThan(17_000);
    await frame.locator('#cancel').press('Enter'); release(); await page.waitForTimeout(500);
    expect(context.pages().some(p => p.url().startsWith(watch))).toBe(false);
    await expect(frame.locator('#status')).toContainText('Вход отменён');
  } finally { release(); await context.close(); }
});
test('background перепроверяет operation после ожидания: отмена не активирует связанную вкладку', async () => {
  const { context, extensionId, worker } = await setup();
  try {
    const watchPage = await context.newPage(); await watchPage.goto(watch);
    const control = await popup(context, watchPage, extensionId);
    const target = new URL((await frameOf(watchPage)).url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const created = await control.request(target, 'create', { metadata: { name: 'Cancel focus', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 0, playbackRate: 1, isPlaying: false } });
    await control.close();
    const page = await context.newPage(); const frame = await invitation(page, created.invitation!.split('room=')[1]!);
    await worker.evaluate(() => {
      const chrome = (globalThis as any).chrome;
      const scope = globalThis as any;
      scope.capacityOriginalGet = chrome.tabs.get.bind(chrome.tabs);
      const gate = new Promise<void>(yes => { scope.capacityRelease = yes; });
      chrome.tabs.get = async (id: number) => { scope.capacityBlocked = true; await gate; return scope.capacityOriginalGet(id); };
    });
    await frame.locator('#join').click(); await expect.poll(() => worker.evaluate(() => !!(globalThis as any).capacityBlocked)).toBe(true);
    await frame.locator('#cancel').press('Enter');
    // Подтверждаем доставку отмены до снятия задержки API.
    await page.waitForTimeout(100);
    await worker.evaluate(() => { (globalThis as any).capacityRelease(); });
    await expect(frame.locator('#status')).toContainText('Вход отменён');
    await page.waitForTimeout(300);
    const active = await worker.evaluate(async () => (await (globalThis as any).chrome.tabs.query({ active: true, currentWindow: true }))[0].url);
    expect(new URL(active).origin).toBe(new URL(hosting).origin);
  } finally { await context.close(); }
});
