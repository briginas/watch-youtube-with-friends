import { chromium, test, expect, type Frame, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { admin, frameOf, sessionPlayback, popup, setup, stopWorker, watch } from './fixtures';

const hosting = 'http://127.0.0.1:5002/';
const newKey = () => randomBytes(32).toString('hex');

async function invitationFrame(page: Page) {
  await expect.poll(() => page.frames().some(frame => frame.url().includes('/invitation.html#'))).toBe(true);
  const frame = page.frames().find(frame => frame.url().includes('/invitation.html#'))!;
  await expect(frame.locator('[role="status"]')).not.toHaveText('Проверяем приглашение…');
  await expect(page.locator('#generation-status')).not.toHaveText('Проверяем поддержку комнаты…');
  return frame;
}

async function storedUid(frame: Frame) {
  // Читаем persistence только из теста; продукт не публикует UID в DOM/hosting.
  return frame.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('firebaseLocalStorageDb');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Auth persistence unavailable'));
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll();
        request.onsuccess = () => resolve(request.result.find(item => item.fbase_key.startsWith('firebase:authUser:'))?.value.uid);
        request.onerror = () => reject(new Error('Auth persistence unreadable'));
      });
    } finally { database.close(); }
  });
}

test('приглашение подключает независимый профиль и получает последующие версии комнаты', async () => {
  const first = await setup();
  const second = await setup();
  try {
    const watchPage = await first.context.newPage();
    await watchPage.goto(watch);
    const control = await popup(first.context, watchPage, first.extensionId);
    const target = new URL((await frameOf(watchPage)).url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    // Исходное состояние fixture передаётся через продуктовый popup bridge.
    const created = await control.request(target, 'create', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
      videoId: 'aqz-KE-bpKQ', positionSeconds: 7.5, playbackRate: 1.5, isPlaying: false,
    } });
    expect(!!created.invitation).toBe(true);
    await control.close();
    const page = await second.context.newPage();
    let authRequests = 0;
    const requestUrls: string[] = [];
    second.context.on('request', request => {
      requestUrls.push(request.url());
      if (request.url().includes(':9099/')) authRequests++;
    });
    await page.goto(created.invitation!);
    const frame = await invitationFrame(page);
    await expect(page.locator('#installation')).toBeHidden();
    await expect(frame.getByRole('button', { name: 'Присоединиться' })).toBeEnabled();
    expect(authRequests).toBe(0);
    // Скрипты hosting-страницы не могут вызвать вход через postMessage.
    await page.evaluate(() => window.postMessage({ type: 'room-invitation', action: 'join' }, location.origin));
    await expect(frame.locator('[role="status"]')).toContainText('Нажмите «Присоединиться»');
    await frame.getByRole('button', { name: 'Присоединиться' }).press('Enter');
    await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    const findGuest = () => second.context.pages().find(candidate => candidate.url() === watch);
    await expect.poll(findGuest).toBeDefined();
    const guestPage = findGuest()!;
    await expect(guestPage).toHaveURL(watch);
    const guest = await frameOf(guestPage);
    await expect.poll(() => sessionPlayback(guest)).toMatchObject({ positionSeconds: 7.5, playbackRate: 1.5, isPlaying: false });
    const secondUid = await storedUid(guest);
    expect(typeof secondUid).toBe('string');
    expect(secondUid === created.uid).toBe(false);
    expect(authRequests).toBeGreaterThan(0);
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    expect(frame.url().includes(key)).toBe(false);
    expect((await page.content()).includes(key)).toBe(false);
    expect(requestUrls.filter(url => url.includes(key)).every(url => new URL(url).origin === 'http://127.0.0.1:9000' && new URL(url).pathname === `/rooms/${key}.json`)).toBe(true);
    // Серверная fixture имитирует следующую принятую версию, без sync engine.
    await admin(`rooms/${key}/playback`, {
      videoId: 'aqz-KE-bpKQ', positionSeconds: 42, playbackRate: 2, isPlaying: true,
      revision: 1, kind: 'playback', videoRevision: 0, actionAt: Date.now(), sampledAt: Date.now(), updatedAt: Date.now(), actorUid: created.uid, commandId: 'next-version',
    });
    await expect.poll(() => sessionPlayback(guest)).toMatchObject({ positionSeconds: 42, playbackRate: 2, isPlaying: true });
    // Повторное приглашение после остановки worker активирует ту же вкладку.
    const stopped = await stopWorker(second.context, page, second.worker);
    await stopped.detach();
    const again = await second.context.newPage();
    await again.goto(created.invitation!);
    const repeated = await invitationFrame(again);
    await repeated.getByRole('button', { name: 'Присоединиться' }).press('Enter');
    await expect(repeated.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    expect(second.context.pages().filter(p => p.url().startsWith(watch))).toHaveLength(1);
    // Закрытие приглашений не снимает presence, reload восстанавливает привязку.
    await again.close();
    await guestPage.reload();
    const restored = await frameOf(guestPage);
    await expect.poll(() => sessionPlayback(restored)).toMatchObject({ positionSeconds: 42, playbackRate: 2, isPlaying: true });
    await expect(restored.getByRole('listitem')).toHaveCount(2);
    // Смена fragment очищает предыдущую подписку и требует нового действия.
    await page.evaluate(() => { location.hash = '#generation=emulator-v1&room=short'; });
    await expect(frame.locator('[role="status"]')).toContainText('Приглашение повреждено');
    await expect(frame.locator('#join')).toBeHidden();
    await expect(frame.locator('#playback')).toBeHidden();
  } finally { await second.context.close(); await first.context.close(); }
});

test('повреждённые и отсутствующие приглашения не создают комнату; можно повторить вход', async () => {
  const { context } = await setup();
  try {
    const page = await context.newPage();
    const key = newKey();
    for (const hash of ['', '#generation=emulator-v1&room=short', `#generation=emulator-v1&room=${key}&room=${key}`, `#generation=emulator-v1&room=${key}&extra=1`]) {
      await page.goto(`${hosting}${hash}`);
      const frame = await invitationFrame(page);
      await expect(frame.locator('[role="status"]')).toContainText('Приглашение повреждено');
      await expect(frame.locator('#join')).toBeHidden();
    }
    await page.goto(`${hosting}#generation=emulator-v1&room=${key}`);
    const frame = await invitationFrame(page);
    await frame.getByRole('button', { name: 'Присоединиться' }).click();
    await expect(frame.locator('[role="status"]')).toHaveText('Комната не найдена.');
    await expect(frame.getByRole('button', { name: 'Повторить' })).toBeEnabled();
    const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
      headers: { Authorization: 'Bearer owner' },
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toBeNull();
    // Настоящий отказ Rules и восстановление, без изменения файла правил.
    await admin('.settings/rules', { rules: { '.read': false, '.write': false } });
    await frame.getByRole('button', { name: 'Повторить' }).click();
    await expect(frame.locator('[role="status"]')).toContainText('Нет доступа к комнате');
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
    await frame.getByRole('button', { name: 'Повторить' }).click();
    await expect(frame.locator('[role="status"]')).toHaveText('Комната не найдена.');
  } finally {
    await context.close();
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
  }
});

test('без расширения страница показывает инструкцию установки и не подтверждает вход', async () => {
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true });
  try {
    const page = await context.newPage();
    await page.goto(`${hosting}#generation=emulator-v1&room=${newKey()}`);
    await expect(page.getByRole('heading', { name: 'Установите расширение' })).toBeVisible();
    await expect(page.locator('#installation')).toContainText('готовится к публикации');
    await expect(page.getByRole('button', { name: 'Присоединиться' })).toHaveCount(0);
    expect(page.frames()).toHaveLength(1);
    expect(await page.content()).not.toContain('Комната подключена.');
  } finally { await context.close(); }
});

test('privacy доступна с расширением без invitation frame и анонимного входа', async () => {
  const { context } = await setup();
  try {
    let authRequests = 0;
    context.on('request', request => { if (request.url().includes(':9099/')) authRequests++; });
    const page = await context.newPage();
    await page.goto(`${hosting}privacy.html#generation=emulator-v1&room=${newKey()}`);
    await expect(page.getByRole('heading', { name: 'Политика конфиденциальности' })).toBeVisible();
    await expect(page.getByText('Контакт поддержки не настроен.')).toBeVisible();
    expect(page.frames()).toHaveLength(1);
    expect(authRequests).toBe(0);
  } finally { await context.close(); }
});

test('чужой origin, порт, путь и вложенный frame не получают bridge приглашения', async () => {
  const { context, extensionId } = await setup();
  try {
    const body = await readFile('firebase/hosting/index.html', 'utf8');
    for (const url of ['http://127.0.0.1:5003/', 'http://localhost:5002/', 'http://127.0.0.1:5002/else']) {
      await context.route(url, route => route.fulfill({ contentType: 'text/html', body }));
      const page = await context.newPage();
      await page.goto(`${url}#generation=emulator-v1&room=${newKey()}`);
      await expect(page.locator('#installation')).toBeVisible();
      // Попытка embedding напрямую не даёт адресату входа и секрета.
      await page.evaluate(async ({ extensionId }) => {
        const frame = document.createElement('iframe');
        frame.src = `chrome-extension://${extensionId}/invitation.html#${crypto.randomUUID()}`;
        await new Promise<void>(resolve => { frame.onload = () => resolve(); document.body.append(frame); });
      }, { extensionId });
      expect(await page.locator('iframe').count()).toBe(1);
      for (const frame of page.frames().slice(1)) {
        await expect(frame.getByRole('button', { name: 'Присоединиться' })).toBeHidden();
      }
      await page.close();
    }
    const page = await context.newPage();
    await page.goto(hosting);
    await invitationFrame(page);
    await page.evaluate(async url => {
      const frame = document.createElement('iframe'); frame.src = url;
      await new Promise<void>(resolve => { frame.onload = () => resolve(); document.body.append(frame); });
    }, `${hosting}#generation=emulator-v1&room=${newKey()}`);
    // Hosting CSP также запрещает embedding hosting-страницы.
    expect(page.frames().filter(frame => frame.url().includes('/invitation.html#'))).toHaveLength(1);
  } finally { await context.close(); }
});
