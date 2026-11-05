import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { admin, frameOf, popup, setup, stopWorker, watch, workerOf } from './fixtures';
import { launchExtension } from '../e2e/fixtures';
import { playerFixture, readyPlayer, sample } from './playback-fixture';

declare const chrome: typeof browserApi;
const body = () => playerFixture().replace('<title>', '<meta charset="UTF-8"><title>').replace('<div id="movie_player"', '<ytd-watch-flexy video-id="aqz-KE-bpKQ"><h1>Название &lt;b&gt;видео&lt;/b&gt;</h1></ytd-watch-flexy><div id="movie_player"');
type Profile = Awaited<ReturnType<typeof setup>>;
async function driver(profile: Profile) {
  const page = await profile.context.newPage();
  await page.goto(`chrome-extension://${profile.extensionId}/popup.html`);
  await expect(page.getByRole('heading', { name: 'Мои комнаты' })).toBeVisible();
  return page;
}
async function list(page: Page) {
  return page.evaluate(async () => chrome.runtime.sendMessage({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'list' })) as Promise<{ entries: { key: string; name: string }[] }>;
}
async function create(profile: Profile) {
  const page = await profile.context.newPage();
  await page.goto(watch);
  await readyPlayer(page);
  const control = await popup(profile.context, page, profile.extensionId);
  const frame = await frameOf(page);
  const target = new URL(frame.url()).hash.slice(1);
  await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Смотреть вместе' && !b.disabled)")).toBe(true);
  await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Смотреть вместе').click(); true");
  await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
  const state = await control.request(target);
  await control.close();
  await expect(frame.locator('#catalog-status')).toBeHidden();
  const key = new URLSearchParams(new URL(state.invitation!).hash.slice(1)).get('room')!;
  const name: string = (await serverRoom(key)).metadata.name;
  return { page, frame, invitation: state.invitation!, key, name };
}
async function invitation(profile: Profile, url: string, click = true) {
  const page = await profile.context.newPage();
  await page.goto(url);
  await expect.poll(() => page.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
  const frame = page.frames().find(f => f.url().includes('/invitation.html#'))!;
  if (click) {
    await frame.getByRole('button', { name: 'Присоединиться', exact: true }).press('Enter');
    await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
  }
  return { page, frame };
}
async function serverRoom(key: string) {
  const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, { headers: { Authorization: 'Bearer owner' } });
  expect(response.ok).toBe(true);
  return response.json();
}
async function denyStorage(worker: Worker, deny: boolean) {
  await worker.evaluate(deny => {
    const scope = globalThis as typeof globalThis & { originalCatalogSet?: typeof chrome.storage.local.set; denyCatalogSet?: boolean };
    scope.denyCatalogSet = deny;
    if (!scope.originalCatalogSet) {
      scope.originalCatalogSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async values => {
        if (scope.denyCatalogSet) throw new Error('Quota failure for catalog test');
        return scope.originalCatalogSet!(values);
      };
    }
  }, deny);
}

test('создание, приглашение, локальность профиля, удаление и повторное принятие', async () => {
  const a = await setup(false, body());
  const b = await setup(false, body());
  try {
    const created = await create(a);
    expect(created.name).toMatch(/^🎬 \d{4}$/u);
    await expect(created.page).toHaveTitle(`${created.name} | Shared playback fixture`);
    const da = await driver(a);
    const db = await driver(b);
    await expect(da.getByRole('region', { name: 'Мои комнаты' }).getByRole('listitem')).toContainText(created.name);
    expect((await list(da)).entries.map(e => e.name)).toEqual([created.name]);
    expect((await list(db)).entries).toEqual([]);
    const guestInvitation = await invitation(b, created.invitation, false);
    expect((await list(db)).entries).toEqual([]);
    const opened = b.context.waitForEvent('page', { timeout: 15_000 });
    await guestInvitation.frame.getByRole('button', { name: 'Присоединиться', exact: true }).press('Enter');
    const guest = await opened;
    await expect(guest).toHaveTitle(`${created.name} | Shared playback fixture`);
    await expect.poll(async () => (await list(db)).entries.map(e => e.name)).toEqual([created.name]);
    await expect.poll(async () => Object.keys((await serverRoom(created.key)).presence ?? {}).length).toBe(2);
    await da.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect.poll(async () => (await list(da)).entries.length).toBe(0);
    await expect.poll(async () => Object.keys((await serverRoom(created.key)).presence ?? {}).length).toBe(2);
    await created.page.reload();
    await frameOf(created.page);
    const worker = await workerOf(a.context);
    await (await stopWorker(a.context, created.page, worker)).detach();
    expect((await list(da)).entries).toEqual([]);
    await invitation(a, created.invitation);
    await expect.poll(async () => (await list(da)).entries.length).toBe(1);
    expect(a.context.pages().filter(p => p.url() === watch)).toHaveLength(1);
    await (await frameOf(guest)).getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    expect((await list(db)).entries).toHaveLength(1);
    await guest.reload();
    await expect.poll(async () => Object.keys((await serverRoom(created.key)).presence ?? {}).length).toBe(1);
  } finally { await a.context.close(); await b.context.close(); }
});

test('конкурентные создания, две комнаты одного видео и открытие из списка/приглашения', async () => {
  const profile = await setup(false, body());
  try {
    // Два реальных session-документа создают разные комнаты конкурентно.
    const pages = await Promise.all([profile.context.newPage(), profile.context.newPage()]);
    for (const page of pages) { await page.goto(watch); await readyPlayer(page); }
    const targets = [];
    for (const page of pages) {
      const control = await popup(profile.context, page, profile.extensionId);
      const target = new URL((await frameOf(page)).url()).hash.slice(1);
      await expect.poll(async () => (await control.request(target)).connected).toBe(true);
      targets.push(target);
      await control.close();
    }
    const d = await driver(profile);
    const states = await d.evaluate(async targets => Promise.all(targets.map((target, index) => chrome.runtime.sendMessage({
      type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'create', metadata: { name: `Комната ${index + 1}`, createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' },
      playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 5 + 5 * index, playbackRate: 1, isPlaying: false },
    }))), targets);
    await expect.poll(async () => (await list(d)).entries.length).toBe(2);
    await expect.poll(() => sample(pages[0]!)).toMatchObject({ positionSeconds: 5 });
    await expect.poll(() => sample(pages[1]!)).toMatchObject({ positionSeconds: 10 });
    await pages[0]!.locator('.ytp-variable-speed-panel-button').click();
    await expect.poll(() => sample(pages[0]!)).toMatchObject({ playbackRate: 1.5 });
    expect((await sample(pages[1]!)).playbackRate).toBe(1);
    for (const page of pages) await page.close();
    const first = (await list(d)).entries.find(e => e.name === 'Комната 1')!;
    const invite = await invitation(profile, states[0]!.invitation!, false);
    await Promise.all([
      d.evaluate(key => chrome.runtime.sendMessage({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'open', room: { key, name: 'Комната 1', videoId: 'aqz-KE-bpKQ', backendGeneration: 'emulator-v1' } }), first.key),
      invite.frame.getByRole('button', { name: 'Присоединиться', exact: true }).click(),
    ]);
    await expect(invite.frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    expect(profile.context.pages().filter(p => p.url() === watch)).toHaveLength(1);
    await expect.poll(async () => Object.values((await serverRoom(first.key)).presence ?? {}).flatMap((p: any) => Object.keys(p.connections)).length).toBe(1);
    await d.getByRole('listitem').filter({ hasText: 'Комната 2' }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect.poll(() => profile.context.pages().filter(p => p.url() === watch).length).toBe(2);
  } finally { await profile.context.close(); }
});

test('ошибки сохранения и удаления не прерывают просмотр; повтор сохранения', async () => {
  const profile = await setup(false, body());
  try {
    await denyStorage(profile.worker, true);
    const page = await profile.context.newPage();
    await page.goto(watch); await readyPlayer(page);
    const control = await popup(profile.context, page, profile.extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const state = await control.request(target, 'create', { metadata: { name: 'Повтор', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 5, playbackRate: 1, isPlaying: false } });
    expect(!!state.invitation).toBe(true);
    await control.close();
    await expect(frame.locator('#catalog-status')).toContainText('не сохранена');
    const d = await driver(profile);
    expect((await list(d)).entries).toEqual([]);
    await denyStorage(profile.worker, false);
    await page.bringToFront();
    await frame.getByRole('button', { name: 'Повторить сохранение' }).focus();
    await frame.getByRole('button', { name: 'Повторить сохранение' }).press('Enter');
    await expect(frame.locator('#catalog-status')).toBeHidden();
    await expect.poll(async () => (await list(d)).entries.length).toBe(1);
    await denyStorage(profile.worker, true);
    await d.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect(d.getByRole('alert')).toContainText('Не удалось обновить список');
    expect((await list(d)).entries).toHaveLength(1);
    await expect(frame.locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем|Локальный просмотр|Нажмите play/);
    await denyStorage(profile.worker, false);
    await d.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect.poll(async () => (await list(d)).entries.length).toBe(0);
  } finally { await profile.context.close(); }
});

test('ошибки комнаты и прежний формат не создают запись; список доступен вне YouTube', async () => {
  const profile = await setup(false, body());
  try {
    const oldKey = randomBytes(32).toString('hex');
    await admin(`rooms/${oldKey}`, { playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 1, playbackRate: 1, isPlaying: false, actionAt: 1, sampledAt: 1, updatedAt: 1, revision: 0, actorUid: 'fixture', commandId: 'initial' } });
    const old = await invitation(profile, `http://127.0.0.1:5002/#generation=emulator-v1&room=${oldKey}`, false);
    await old.frame.getByRole('button', { name: 'Присоединиться' }).click();
    await expect(old.frame.locator('[role="status"]')).toContainText('Формат комнаты не поддерживается');
    const d = await driver(profile);
    expect((await list(d)).entries).toEqual([]);
    const created = await create(profile);
    await created.page.close();
    const outside = await profile.context.newPage(); await outside.goto('about:blank');
    const control = await popup(profile.context, outside, profile.extensionId);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain(created.name);
    await control.close();
    await admin(`rooms/${created.key}`, null);
    await d.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(d.getByRole('alert')).toContainText('Комната не найдена');
    expect((await list(d)).entries).toHaveLength(1);
    expect(profile.context.pages().filter(p => p.url() === watch)).toHaveLength(0);
    // Отказ доступа при существующей записи; повтор после восстановления Rules.
    await admin('.settings/rules', { rules: { '.read': false, '.write': false } });
    await d.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(d.getByRole('alert')).toContainText('Нет доступа');
  } finally {
    const { readFile } = await import('node:fs/promises');
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
    await profile.context.close();
  }
});

test('content script не читает каталог и не вызывает привилегированные операции', async () => {
  const profile = await setup(false, body());
  try {
    const created = await create(profile);
    const cdp = await profile.context.newCDPSession(created.page);
    const contexts: any[] = [];
    cdp.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await cdp.send('Runtime.enable');
    const { frameTree } = await cdp.send('Page.getFrameTree');
    let isolated: number | undefined;
    for (const context of contexts.filter(c => c.auxData?.frameId === frameTree.frame.id && c.auxData?.isDefault === false)) {
      const result = await cdp.send('Runtime.evaluate', { contextId: context.id, expression: 'globalThis.chrome?.runtime?.id', returnByValue: true });
      if (result.result.value === profile.extensionId) isolated = context.id;
    }
    expect(isolated).toBeDefined();
    const target = new URL((await frameOf(created.page)).url()).hash.slice(1);
    const playback = { ...(await serverRoom(created.key)).playback, actorUid: 'spoof' };
    const result = await cdp.send('Runtime.evaluate', { contextId: isolated, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        let blocked = false;
        try { await chrome.storage.local.get(null); } catch { blocked = true; }
        const response = await chrome.runtime.sendMessage({type:'room-catalog',backendGeneration:'emulator-v1',action:'list'});
        const view = await chrome.runtime.sendMessage(${JSON.stringify({ type: 'room-tab-view', backendGeneration: 'emulator-v1', target, playback,
          route: { videoId: 'aqz-KE-bpKQ', sequence: 0 }, ownCommand: true, force: true })});
        const pending = await chrome.runtime.sendMessage(${JSON.stringify({ type: 'room-tab-switch-pending', backendGeneration: 'emulator-v1', target,
          pending: { commandId: 'spoof', videoId: 'dQw4w9WgXcQ' } })});
        return {blocked, leaked: !!response, privilegedView: !!view, privilegedSwitch: !!pending};
      })()` });
    expect(result.result.value).toEqual({ blocked: true, leaked: false, privilegedView: false, privilegedSwitch: false });
    await cdp.detach();
  } finally { await profile.context.close(); }
});

test('полный перезапуск профиля сохраняет список без автоматического подключения', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'room-catalog-'));
  const extension = resolve('.output/room-transport/chrome-mv3');
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(extension, [], true, directory);
    await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: body() }));
    let worker = await workerOf(context);
    let profile = { context, worker, extensionId: new URL(worker.url()).host };
    const created = await create(profile);
    const key = created.key;
    await context.close();
    context = await launchExtension(extension, [], true, directory);
    await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: body() }));
    worker = await workerOf(context); profile = { context, worker, extensionId: new URL(worker.url()).host };
    const d = await driver(profile);
    expect((await list(d)).entries.map(e => e.name)).toEqual([created.name]);
    expect(context.pages().filter(p => p.url() === watch)).toHaveLength(0);
    await expect.poll(async () => Object.keys((await serverRoom(key)).presence ?? {}).length).toBe(0);
    await d.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect.poll(() => context!.pages().filter(p => p.url() === watch).length).toBe(1);
    await expect.poll(async () => Object.keys((await serverRoom(key)).presence ?? {}).length).toBe(1);
  } finally { await context?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('popup различает текущую и другую комнату одного видео, detached/offline и выход', async () => {
  const profile = await setup(false, body());
  try {
    const first = await create(profile);
    const second = await create(profile);
    await first.page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(first.page);
    const frame = await frameOf(first.page);
    await expect(frame.locator('#player-status')).toContainText('Не синхронизируется');
    await profile.context.setOffline(true);
    const control = await popup(profile.context, first.page, profile.extensionId);
    const rows = () => control.evaluate<{ name: string; current: boolean; buttons: string[] }[]>(`Array.from(document.querySelectorAll('li')).map(row => ({
      name: row.querySelector('span')?.textContent,
      current: row.textContent.includes('В этой вкладке'),
      buttons: Array.from(row.querySelectorAll('button')).map(button => button.getAttribute('aria-label') || button.textContent)
    }))`);
    await expect.poll(rows).toEqual(expect.arrayContaining([
      { name: first.name, current: true, buttons: ['Убрать из списка'] },
      { name: second.name, current: false, buttons: ['Перейти', 'Убрать из списка'] },
    ]));
    await profile.context.setOffline(false);
    const target = new URL(frame.url()).hash.slice(1);
    await control.request(target, 'unwatch');
    await expect.poll(rows).toEqual(expect.arrayContaining([
      { name: first.name, current: false, buttons: ['Открыть', 'Убрать из списка'] },
    ]));
    await control.close();
  } finally { await profile.context.setOffline(false); await profile.context.close(); }
});

test('каталог обновляет действия при активации и закрытии вкладки; переход работает offline', async () => {
  const profile = await setup(false, body());
  try {
    const created = await create(profile);
    const d = await driver(profile);
    const row = d.getByRole('listitem');
    await expect(row.getByRole('button', { name: 'Перейти', exact: true })).toBeVisible();
    await created.page.bringToFront();
    await expect(row.getByText('В этой вкладке', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /^(Открыть|Перейти)$/ })).toHaveCount(0);
    await d.bringToFront();
    await expect(row.getByRole('button', { name: 'Перейти', exact: true })).toBeVisible();
    const before = profile.context.pages().length;
    await profile.context.setOffline(true);
    await row.getByRole('button', { name: 'Перейти', exact: true }).click();
    await expect(row.getByText('В этой вкладке', { exact: true })).toBeVisible();
    expect(profile.context.pages()).toHaveLength(before);
    await created.page.close();
    await expect(row.getByRole('button', { name: 'Открыть', exact: true })).toBeVisible();
    await expect(row.getByText('В этой вкладке', { exact: true })).toHaveCount(0);
  } finally { await profile.context.setOffline(false); await profile.context.close(); }
});

test('показ списка не создаёт presence, ошибка сети допускает повтор, popup передаёт открытие worker', async () => {
  const profile = await setup(false, body());
  try {
    const created = await create(profile);
    await created.page.close();
    const d = await driver(profile);
    await expect.poll(async () => Object.keys((await serverRoom(created.key)).presence ?? {}).length).toBe(0);
    await d.setViewportSize({ width: 336, height: 600 });
    await profile.context.setOffline(true);
    await d.getByRole('button', { name: 'Открыть', exact: true }).click();
    const row = d.getByRole('region', { name: 'Мои комнаты' }).getByRole('listitem');
    const cancel = row.getByRole('button', { name: 'Отмена', exact: true });
    const pending = row.getByRole('status');
    await expect(cancel).toBeEnabled();
    await expect(pending).toHaveText('Открываем комнату…');
    await expect(row.getByRole('button', { name: /Подождите|Открыть/ })).toHaveCount(0);
    const [spinnerBox, cancelBox, removeBox] = await Promise.all([
      pending.boundingBox(), cancel.boundingBox(), row.getByRole('button', { name: 'Убрать из списка' }).boundingBox(),
    ]);
    if (!spinnerBox || !cancelBox || !removeBox) throw new Error('Элементы ожидания должны быть видимы');
    expect(spinnerBox.width).toBeGreaterThan(0);
    expect(spinnerBox.x + spinnerBox.width).toBeLessThan(cancelBox.x);
    expect(Math.abs(spinnerBox.y + spinnerBox.height / 2 - (cancelBox.y + cancelBox.height / 2))).toBeLessThan(1);
    expect(Math.abs(cancelBox.y + cancelBox.height / 2 - (removeBox.y + removeBox.height / 2))).toBeLessThan(1);
    expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(336);
    await expect(d.getByRole('alert')).toContainText('Проверьте интернет', { timeout: 25_000 });
    await expect(cancel).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
    expect((await list(d)).entries).toHaveLength(1);
    // Завершаем попытку первого документа перед входом из отдельного popup.
    await cancel.click();
    await expect(pending).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Открыть', exact: true })).toBeEnabled();
    await profile.context.setOffline(false);
    const outside = await profile.context.newPage(); await outside.goto('about:blank');
    const control = await popup(profile.context, outside, profile.extensionId);
    await expect.poll(() => control.evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Открыть' && !b.disabled)")).toBe(true);
    const opened = profile.context.waitForEvent('page', { timeout: 15_000 });
    await control.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Открыть').click(); true");
    const viewing = await opened;
    await expect(viewing).toHaveURL(watch);
    await expect((await frameOf(viewing)).locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем|Локальный просмотр|Нажмите play/);
    // Worker обязан сфокусировать окно уже связанной вкладки.
    const targetWindow = await d.evaluate(async watch => {
      const [tab] = await chrome.tabs.query({ url: watch });
      return (await chrome.windows.create({ tabId: tab!.id }))!.id;
    }, watch);
    // bringToFront активирует вкладку, но не гарантирует фокус её окна.
    await d.evaluate(async () => {
      const current = await chrome.windows.getCurrent();
      await chrome.windows.update(current.id!, { focused: true });
    });
    await d.bringToFront();
    await d.getByRole('button', { name: 'Перейти', exact: true }).click({ timeout: 10_000 });
    await expect.poll(() => d.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(targetWindow);
    expect(profile.context.pages().filter(p => p.url() === watch)).toHaveLength(1);
  } finally { await profile.context.setOffline(false); await profile.context.close(); }
});

test('повреждённая запись не скрывает корректную и чужой namespace не показывается', async () => {
  const profile = await setup(false, body());
  try {
    const created = await create(profile);
    const d = await driver(profile);
    await d.evaluate(async () => {
      const data = await chrome.storage.local.get(null);
      const key = Object.keys(data).find(key => key.startsWith('roomCatalog:'))!;
      const value = data[key] as { version: number; entries: unknown[] };
      value.entries.push({ key: 'damaged' });
      await chrome.storage.local.set({ [key]: value, 'roomCatalog:another-server': { version: 1, entries: [{ name: 'Чужая комната' }] } });
    });
    await expect(d.getByRole('alert')).toContainText('Часть списка');
    expect((await list(d)).entries.map(e => e.name)).toEqual([created.name]);
    await expect(d.getByRole('region', { name: 'Мои комнаты' }).getByRole('listitem')).toHaveCount(1);
  } finally { await profile.context.close(); }
});

test('смена сохраняет имя и приглашение, не возвращает удалённый каталог; закрытая комната читает новое видео', async () => {
  const profile = await setup(false, body());
  try {
    const created = await create(profile);
    const catalog = await driver(profile);
    const before = await serverRoom(created.key);
    await catalog.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect.poll(async () => (await list(catalog)).entries.length).toBe(0);
    await created.page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(created.page);
    await (await frameOf(created.page)).getByRole('button', { name: 'Смотреть это в комнате', exact: true }).click();
    await expect.poll(async () => (await serverRoom(created.key)).playback.videoId).toBe('dQw4w9WgXcQ');
    expect((await serverRoom(created.key)).metadata).toEqual(before.metadata);
    await created.page.reload();
    await frameOf(created.page);
    await (await stopWorker(profile.context, created.page, await workerOf(profile.context))).detach();
    expect((await list(catalog)).entries).toEqual([]);
    await invitation(profile, created.invitation);
    expect((await list(catalog)).entries.map(e => e.name)).toEqual([created.name]);
    await created.page.close();
    await catalog.bringToFront();
    const opened = profile.context.waitForEvent('page', { timeout: 15_000 });
    await catalog.getByRole('button', { name: 'Открыть', exact: true }).click();
    const page = await opened;
    await expect(page).toHaveURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await expect((await frameOf(page)).locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/);
  } finally { await profile.context.close(); }
});

test('смена одной комнаты не меняет другую; активация живой detached-вкладки сохраняет локальный просмотр', async () => {
  const profile = await setup(false, body());
  try {
    const first = await create(profile);
    const second = await create(profile);
    const d = await driver(profile);
    const untouched = (await serverRoom(second.key)).playback;
    await first.page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(first.page);
    await (await frameOf(first.page)).getByRole('button', { name: 'Смотреть это в комнате', exact: true }).click();
    await expect.poll(async () => (await serverRoom(first.key)).playback.revision).toBe(1);
    expect((await serverRoom(second.key)).playback).toEqual(untouched);
    await first.page.goto('https://www.youtube.com/watch?v=M7lc1UVf-VE');
    const frame = await frameOf(first.page);
    await expect(frame.locator('#player-status')).toContainText('Не синхронизируется');
    await d.evaluate(key => chrome.runtime.sendMessage({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'activate', key }), first.key);
    await expect(first.page).toHaveURL('https://www.youtube.com/watch?v=M7lc1UVf-VE');
    await expect(frame.locator('#player-status')).toContainText('Не синхронизируется');
    expect((await serverRoom(first.key)).playback.revision).toBe(1);
    expect((await serverRoom(second.key)).playback).toEqual(untouched);
  } finally { await profile.context.close(); }
});
