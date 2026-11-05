import { expect, test, type Frame, type Page } from '@playwright/test';
import { frameOf, sessionPlayback, popup, setup, watch } from './fixtures';

async function storedAuth(frame: Frame) {
  return frame.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('firebaseLocalStorageDb');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ uid: string; token: string }>((resolve, reject) => {
        const request = database.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll();
        request.onsuccess = () => {
          const user = request.result.find(item => item.fbase_key.startsWith('firebase:authUser:')).value;
          resolve({ uid: user.uid, token: user.stsTokenManager.accessToken });
        };
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

async function readRoom(invitation: string) {
  const key = new URLSearchParams(new URL(invitation).hash.slice(1)).get('room')!;
  const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
    headers: { Authorization: 'Bearer owner' },
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function join(page: Page, invitation: string) {
  await page.goto(invitation);
  await expect.poll(() => page.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
  const frame = page.frames().find(f => f.url().includes('/invitation.html#'))!;
  const opened = page.context().waitForEvent('page');
  await frame.getByRole('button', { name: /^(Присоединиться|Открыть вкладку комнаты)$/ }).click();
  const watchPage = await opened;
  await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
  return frameOf(watchPage);
}

async function create(first: Awaited<ReturnType<typeof setup>>) {
  const page = await first.context.newPage();
  await page.goto(watch);
  const control = await popup(first.context, page, first.extensionId);
  const frame = await frameOf(page);
  const target = new URL(frame.url()).hash.slice(1);
  await expect.poll(async () => (await control.request(target)).connected).toBe(true);
  const created = await control.request(target, 'create', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
    videoId: 'aqz-KE-bpKQ', positionSeconds: 7.5, playbackRate: 1.5, isPlaying: false,
  } });
  expect(!!created.invitation).toBe(true);
  await expect(frame.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
  return { page, frame, control, target, invitation: created.invitation!, uid: created.uid! };
}

test('два профиля: разные номера/цвета, «вы», выход создателя и управление оставшегося', async () => {
  const first = await setup();
  const second = await setup();
  try {
    const creator = await create(first);
    await creator.control.close();
    const page = await second.context.newPage();
    let guest = await join(page, creator.invitation);
    for (const frame of [creator.frame, guest]) {
      await expect(frame.locator('#participants')).toContainText('Участников: 2');
      await expect(frame.getByRole('listitem')).toHaveCount(2);
      expect(await frame.getByRole('listitem').allTextContents()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Участник 1/), expect.stringMatching(/^Участник 2/),
      ]));
      expect((await frame.getByRole('listitem').allTextContents()).filter(text => text.includes('(вы)'))).toHaveLength(1);
    }
    const colors = await guest.getByRole('listitem').evaluateAll(items => items.map(item => (item as HTMLElement).style.color));
    expect(new Set(colors).size).toBe(2);
    expect(await creator.frame.getByRole('listitem').evaluateAll(items => items.map(item => (item as HTMLElement).style.color))).toEqual(colors);
    const auth = await storedAuth(guest);
    expect(auth.uid === creator.uid).toBe(false);
    const roomBefore = await readRoom(creator.invitation);
    expect(Object.keys(roomBefore.presence).length).toBe(2);
    const guestControl = await popup(second.context, guest.page(), second.extensionId);
    const copyButton = `document.querySelector('button[aria-label="Копировать приглашение"]')`;
    await expect.poll(() => guestControl.evaluate<boolean>(`${copyButton}?.disabled === false`)).toBe(true);
    await guestControl.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (value) => { window.copiedInvitation = value; }
    }); ${copyButton}.click(); true`);
    await expect.poll(() => guestControl.evaluate<boolean>(
      `window.copiedInvitation === ${JSON.stringify(creator.invitation)}`,
    )).toBe(true);
    await guestControl.close();
    // Проверяем popup UI и выход через него.
    const control = await popup(first.context, creator.page, first.extensionId);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Участников: 2');
    expect(await control.evaluate<boolean>("document.querySelector('details')?.open === false")).toBe(true);
    await control.evaluate("document.querySelector('summary').click(); true");
    await control.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Выйти из комнаты').click(); true`);
    await expect.poll(async () => (await control.request(creator.target)).room === null).toBe(true);
    await control.close();
    await expect(creator.frame.locator('#participants')).toBeHidden();
    await expect(guest.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
    await expect.poll(async () => Object.keys((await readRoom(creator.invitation)).presence ?? {}).length).toBe(1);
    expect((await readRoom(creator.invitation)).playback).toEqual(roomBefore.playback);
    // Без sync engine проверяем серверное право оставшегося UID настоящим ID token.
    const key = new URLSearchParams(new URL(creator.invitation).hash.slice(1)).get('room')!;
    const response = await fetch(`http://127.0.0.1:9000/rooms/${key}/playback.json?ns=demo-watch-together-default-rtdb&auth=${auth.token}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        ...roomBefore.playback, actorUid: auth.uid, commandId: crypto.randomUUID(),
        revision: 1, positionSeconds: 42, actionAt: Date.now(), sampledAt: Date.now(), updatedAt: { '.sv': 'timestamp' },
      }),
    });
    expect(response.ok).toBe(true);
    await expect.poll(() => sessionPlayback(guest)).toMatchObject({ positionSeconds: 42 });
    await guest.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
    await expect(guest.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    await expect.poll(async () => (await readRoom(creator.invitation)).presence ?? null).toBeNull();
    expect((await readRoom(creator.invitation)).playback.revision).toBe(1);
    // Явный выход не подписывает комнату заново при следующих обновлениях.
    guest = await join(page, creator.invitation);
    await expect(guest.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
  } finally { await second.context.close(); await first.context.close(); }
});

test('приглашение в своём профиле использует вкладку создателя и одно presence-соединение', async () => {
  const first = await setup();
  try {
    const creator = await create(first);
    await creator.control.close();
    const page = await first.context.newPage();
    await page.goto(creator.invitation);
    await expect.poll(() => page.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const invitation = page.frames().find(f => f.url().includes('/invitation.html#'))!;
    await invitation.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    await expect(invitation.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    expect(first.context.pages().filter(p => p.url().startsWith(watch))).toHaveLength(1);
    await expect.poll(async () => Object.keys((await readRoom(creator.invitation)).presence[creator.uid].connections).length).toBe(1);
    await page.close();
    await expect(creator.frame.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
    await creator.page.close();
    await expect.poll(async () => (await readRoom(creator.invitation)).presence ?? null).toBeNull();
    expect((await readRoom(creator.invitation)).playback.videoId).toBe('aqz-KE-bpKQ');
  } finally { await first.context.close(); }
});

test('обрыв сети, reconnect и выход offline не оставляют лишних соединений', async () => {
  const first = await setup();
  const second = await setup();
  try {
    const creator = await create(first);
    await creator.control.close();
    const page = await second.context.newPage();
    let guest = await join(page, creator.invitation);
    await expect(guest.getByRole('listitem')).toHaveCount(2);
    await second.context.setOffline(true);
    await expect(guest.locator('[role="status"]')).toContainText('Просмотр остаётся локальным.');
    await expect(creator.frame.getByRole('listitem')).toHaveCount(1);
    await second.context.setOffline(false);
    await expect(guest.getByRole('listitem')).toHaveCount(2);
    await expect(creator.frame.getByRole('listitem')).toHaveCount(2);
    await expect.poll(async () => Object.values((await readRoom(creator.invitation)).presence)
      .map((p: any) => Object.keys(p.connections).length)).toEqual([1, 1]);
    await second.context.setOffline(true);
    await expect(guest.locator('[role="status"]')).toContainText('Просмотр остаётся локальным.');
    await guest.getByRole('button', { name: 'Выйти из комнаты', exact: true }).press('Enter');
    await second.context.setOffline(false);
    await expect(guest.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    await expect(creator.frame.getByRole('listitem')).toHaveCount(1);
    await expect.poll(async () => Object.keys((await readRoom(creator.invitation)).presence).length).toBe(1);
    // Повторный явный вход создаёт ровно одно новое соединение.
    guest = await join(page, creator.invitation);
    await expect(guest.getByRole('listitem')).toHaveCount(2);
    await expect.poll(async () => Object.values((await readRoom(creator.invitation)).presence)
      .map((p: any) => Object.keys(p.connections).length)).toEqual([1, 1]);
  } finally { await second.context.close(); await first.context.close(); }
});
