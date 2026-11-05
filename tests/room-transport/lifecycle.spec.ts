import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type BrowserContext, type CDPSession } from '@playwright/test';
import { admin, frameOf, popup, setup, stopWorker, watch } from './fixtures';

const key = randomBytes(24).toString('base64url');
const fixture = (name: string) => ({ metadata: { name, createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
  videoId: 'aqz-KE-bpKQ', positionSeconds: 0, playbackRate: 1, isPlaying: false,
  actionAt: 1, sampledAt: 1, updatedAt: 1, revision: 0, kind: 'playback' as const, videoRevision: 0, actorUid: 'fixture', commandId: 'initial',
} });

test('основной transport: общий UID, подписки без popup/worker, reload, ошибки доступа и очистка', async () => {
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  const contexts: BrowserContext[] = [];
  let stopped: CDPSession | undefined;
  try {
    // Только fixture этой матрицы: Rules комнат — отдельная задача 2.2.
    // Постоянные Rules из репозитория не открываем.
    await admin('.settings/rules', { rules: { rooms: { [key]: { '.read': 'auth != null', '.write': false } } } });
    await admin(`rooms/${key}`, fixture('initial'));
    const a = await setup(); contexts.push(a.context);
    const b = await setup(); contexts.push(b.context);
    const pageA = await a.context.newPage();
    const pageB = await a.context.newPage();
    const observer = await b.context.newPage();
    await Promise.all([pageA.goto(watch), pageB.goto(watch), observer.goto(watch)]);
    const errors: string[] = [];
    for (const page of [pageA, pageB, observer]) page.on('pageerror', (error) => errors.push(error.message));
    let control = await popup(a.context, pageA, a.extensionId);
    const frameA = await frameOf(pageA);
    const targetA = new URL(frameA.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(targetA)).connected).toBe(true);
    const uid = (await control.request(targetA)).uid;
    expect(uid).toBeTruthy();
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Подключено. Комната ещё не выбрана.');
    await control.request(targetA, 'watch', { key });
    await expect.poll(async () => (await control.request(targetA)).room).toEqual(fixture('initial'));
    await control.close();

    control = await popup(a.context, pageB, a.extensionId);
    const frameB = await frameOf(pageB);
    const targetB = new URL(frameB.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(targetB)).connected).toBe(true);
    expect((await control.request(targetB)).uid).toBe(uid);
    await control.request(targetB, 'watch', { key });
    await control.close();

    const other = await popup(b.context, observer, b.extensionId);
    const observerFrame = await frameOf(observer);
    const otherTarget = new URL(observerFrame.url()).hash.slice(1);
    await expect.poll(async () => (await other.request(otherTarget)).connected).toBe(true);
    expect((await other.request(otherTarget)).uid).not.toBe(uid);
    await other.close();

    // Без popup и worker наблюдаем работу подписок через обычный UI.
    stopped = await stopWorker(a.context, pageA, a.worker);
    await admin(`rooms/${key}`, null);
    // Публичный UI сессии отражает ошибку room subscription.
    await expect(frameA.locator('[role="status"]')).toContainText('Комната не найдена.');
    await expect(frameB.locator('[role="status"]')).toContainText('Комната не найдена.');
    await stopped.detach(); stopped = undefined;
    await admin(`rooms/${key}`, fixture('after-worker'));
    control = await popup(a.context, pageA, a.extensionId);
    await expect.poll(async () => (await control.request(targetA)).room).toEqual(fixture('after-worker'));
    expect((await control.request(targetA)).uid).toBe(uid);
    await control.close();

    await pageA.reload();
    control = await popup(a.context, pageA, a.extensionId);
    const reloaded = await frameOf(pageA);
    const newTarget = new URL(reloaded.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(newTarget)).connected).toBe(true);
    expect((await control.request(newTarget)).uid).toBe(uid);
    await control.request(newTarget, 'watch', { key });
    await expect.poll(async () => (await control.request(newTarget)).room).toEqual(fixture('after-worker'));
    // Переключение снимает прежнюю подписку; отказ доступа не оставляет старые данные.
    await control.request(newTarget, 'watch', { key: 'x'.repeat(32) });
    await expect.poll(async () => (await control.request(newTarget)).roomError).toContain('Нет доступа');
    expect((await control.request(newTarget)).room).toBeNull();
    await admin(`rooms/${key}`, fixture('must-not-arrive'));
    expect((await control.request(newTarget)).room).toBeNull();
    await control.request(newTarget, 'unwatch');
    expect((await control.request(newTarget)).roomError).toBeNull();
    await control.close();
    await pageA.close();
    await admin(`rooms/${key}`, null);
    await expect(frameB.locator('[role="status"]')).toContainText('Комната не найдена.');
    expect(errors).toEqual([]);
  } finally {
    await stopped?.detach();
    await Promise.all(contexts.map((context) => context.close()));
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
  }
});

test('ошибка Anonymous Auth понятна; повторная попытка восстанавливает подключение', async () => {
  const { context, extensionId } = await setup();
  let rejectAuth = false;
  let frameRejected = 0;
  await context.route('http://127.0.0.1:9099/**', (route) => {
    if (rejectAuth && route.request().url().includes('accounts:signUp')) {
      frameRejected++;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'OPERATION_NOT_ALLOWED' } }) });
    }
    return route.continue();
  });
  try {
    const page = await context.newPage();
    await page.goto(watch);
    const control = await popup(context, page, extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const patterns = [{ urlPattern: '*127.0.0.1:9099/*accounts:signUp*' }];
    rejectAuth = true;
    await control.protocol('Fetch.enable', { patterns });
    // Удаляем сохранённую идентичность перед перезагрузкой обоих контекстов.
    // Ошибка приходит настоящему SDK как HTTP-ответ, Auth API не подменяется.
    const clearIdentity = async () => {
      const db = await new Promise<IDBDatabase>((done, reject) => {
        const request = indexedDB.open('firebaseLocalStorageDb');
        request.onsuccess = () => done(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((done, reject) => {
        const transaction = db.transaction('firebaseLocalStorage', 'readwrite');
        transaction.objectStore('firebaseLocalStorage').clear();
        transaction.oncomplete = () => done();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    };
    await frame.evaluate(clearIdentity);
    await control.evaluate(`(${clearIdentity.toString()})()`);
    // Навигация на тот же URL с #fragment может не перезагрузить документ.
    await Promise.all([
      frame.goto(frame.url().replace('/session.html#', '/session.html?reload=1#')),
      control.protocol('Page.reload'),
    ]);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Не удалось выполнить анонимный вход');
    await expect(frame.locator('[role="status"]')).toContainText('Не удалось выполнить анонимный вход');
    // Popup теперь читает состояние watch-документа и не запускает свой Auth.
    expect(control.rejectedAuthRequests()).toBe(0);
    expect(frameRejected).toBeGreaterThan(0);
    await control.protocol('Fetch.disable');
    rejectAuth = false;
    await control.evaluate('document.querySelector("button").click(); true');
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Подключено. Комната ещё не выбрана.');
    expect((await control.request(target)).uid).toBeTruthy();
    await control.close();
  } finally { await context.close(); }
});

test('session iframe и Anonymous Auth на настоящем YouTube', async () => {
  test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  const { context, extensionId } = await setup(true);
  try {
    const page = await context.newPage();
    await page.goto(`${watch}&hl=en`, { waitUntil: 'domcontentloaded' });
    const control = await popup(context, page, extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Подключено. Комната ещё не выбрана.');
    await control.close();
    await expect(frame.locator('[role="status"]')).toContainText('Подключено. Комната ещё не выбрана.');
    // На странице нет доступа к Auth/room bridge.
    expect(await page.evaluate(() => 'firebaseProbe' in globalThis || 'roomTransport' in globalThis)).toBe(false);
  } finally { await context.close(); }
});
