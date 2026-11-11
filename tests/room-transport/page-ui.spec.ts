import { expect, test, type Page } from '@playwright/test';
import { frameOf, openDetails, panelBounds, settlePanel, sessionPlayback, popup, setup, stopWorker, watch, workerOf } from './fixtures';
import { playerFixture, readyPlayer, withPlaybackPair } from './playback-fixture';
import type { browser as browserApi } from 'wxt/browser';
declare const chrome: typeof browserApi;

type Driver = Awaited<ReturnType<typeof setup>>;
async function create(driver: Driver, name = 'Комната <b>друзей</b>') {
  const page = await driver.context.newPage();
  await page.goto(watch);
  await readyPlayer(page);
  const control = await popup(driver.context, page, driver.extensionId);
  const frame = await frameOf(page, false);
  const target = new URL(frame.url()).hash.slice(1);
  await expect.poll(async () => (await control.request(target)).connected).toBe(true);
  // Без regression-helper раскрытия: проверяем реальный начальный UI.
  const state = await control.evaluate<import("../../src/lib/room/transport").TransportState>(`chrome.runtime.sendMessage(${JSON.stringify({
    type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'create', metadata: { name, createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' },
    playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 10, playbackRate: 1, isPlaying: false },
  })})`);
  expect(!!state.invitation).toBe(true);
  await expect(frame.locator('#room-toggle')).toBeVisible();
  await control.close();
  await page.bringToFront();
  return { page, frame, target, invitation: state.invitation as string };
}
async function hostBounds(page: Page) {
  return panelBounds(await frameOf(page, false));
}


async function panelVisibility(frame: import('@playwright/test').Frame) {
  return (await frame.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility);
}

test('общие темы popup и панели: live-переключение, контраст, геометрия и сохранение комнаты', async ({}, info) => {
  const driver = await setup(false, playerFixture());
  const key = 'watch-together:popup-theme:v1';
  try {
    const { page, frame, invitation } = await create(driver, 'Вечер вместе');
    await openDetails(frame);
    await settlePanel(frame);
    const before = await sessionPlayback(frame);
    const geometry = await frame.locator('#room-panel').boundingBox();
    const control = await driver.context.newPage();
    await control.goto(`chrome-extension://${driver.extensionId}/popup.html`);
    const toggleTheme = control.getByRole('switch', { name: 'Тёмная тема' });
    const colors = () => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(['page', 'surface', 'surface-hover', 'text', 'muted', 'border', 'accent', 'accent-text', 'error', 'connected', 'warning'].map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
    };
    const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((total, channel, i) => total + channel * [.2126, .7152, .0722][i]!, 0);
    const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await toggleTheme.press('Space');
      await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'true');
      expect(await frame.locator('#room-panel').boundingBox()).toEqual(geometry);
      const panelColors = await frame.evaluate(colors);
      expect(panelColors).toEqual(await control.evaluate(colors));
      for (const foreground of ['text', 'muted', 'error']) for (const background of ['surface', 'surface-hover']) {
        expect(contrast(panelColors[foreground]!, panelColors[background]!), `${theme}: ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(panelColors['accent-text']!, panelColors.accent!)).toBeGreaterThanOrEqual(4.5);
      for (const button of await frame.getByRole('button').all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await expect(frame.locator('.participant-dot')).toHaveCount(1);
      expect(await frame.locator('li').evaluate(el => getComputedStyle(el).color)).toBe(await frame.locator('h1').evaluate(el => getComputedStyle(el).color));
      await page.bringToFront();
      await frame.locator('#room-toggle').evaluate(el => el.blur());
      await frame.locator('#room-panel').screenshot({ path: info.outputPath(`${theme}.png`) });
      await control.bringToFront();
    }
    expect(await sessionPlayback(frame)).toEqual(before);
    // A newly opened iframe reads the saved preference, without recreating the room.
    await page.reload();
    await readyPlayer(page);
    const reopened = await frameOf(page, false);
    await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(reopened.locator('#room-name')).toHaveText('Вечер вместе');
    await expect.poll(async () => {
      const transport = await control.evaluate(target => chrome.runtime.sendMessage({ type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'status' }), new URL(reopened.url()).hash.slice(1));
      return transport.roomInvitation === invitation;
    }).toBe(true);
    for (const value of ['unknown', null]) {
      await control.evaluate(async ({ key, value }) => {
        if (value === null) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set({ [key]: value });
      }, { key, value });
      await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'light');
    }
    await page.setViewportSize({ width: 336, height: 480 });
    await openDetails(reopened);
    await settlePanel(reopened);
    expect((await panelBounds(reopened)).width).toBeLessThanOrEqual(312);
    await expect(reopened.locator('#leave')).toBeInViewport();
    expect(await reopened.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(312);
    await control.close();
  } finally { await driver.context.close(); }
});

test('компактный UI: исходное состояние, клавиатура, размеры, clipboard и неизменность комнаты', async ({}, info) => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame, invitation } = await create(driver);
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(frame.locator('#room-details')).toBeHidden();
    await expect(frame.locator('#status')).toHaveText('Смотрим вместе');
    await expect(frame.locator('#room-name')).toHaveText('Комната <b>друзей</b>');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: 1');
    expect((await hostBounds(page))!.height).toBeLessThanOrEqual(88);
    await expect(page).toHaveTitle('Комната <b>друзей</b> | Shared playback fixture');
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
    await expect(frame.locator('#room-details')).toBeHidden();
    await driver.context.grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
    expect(await page.evaluate(async link => (await navigator.clipboard.readText()) === link, invitation)).toBe(true);
    await frame.locator('#room-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(frame.locator('#room-details')).toBeVisible();
    await expect(frame.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
    await page.keyboard.press('Escape');
    await expect(frame.locator('#room-toggle')).toBeFocused();
    await expect(frame.locator('#room-details')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(frame.locator('#room-details')).toBeVisible();
    await settlePanel(frame);
    expect((await frame.locator('#room-details').boundingBox())!.y).toBeLessThan((await frame.locator('#room-dock').boundingBox())!.y);
    const key = new URLSearchParams(new URL(invitation).hash.slice(1)).get('room')!;
    expect((await page.content()).includes(key)).toBe(false);
    expect((await page.title()).includes(key)).toBe(false);
    expect(frame.url().includes(key)).toBe(false);
    await page.screenshot({ path: info.outputPath('page-ui.png') });
  } finally { await driver.context.close(); }
});

test('геометрия: длинное имя, маленькое окно, доступность выхода и клики за пределами индикатора', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame } = await create(driver, 'Название'.repeat(25));
    await page.setViewportSize({ width: 640, height: 480 });
    await openDetails(frame);
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).scrollIntoViewIfNeeded();
    await expect(frame.getByRole('button', { name: 'Выйти из комнаты' })).toBeInViewport();
    await expect.poll(async () => (await hostBounds(page))!.height).toBeLessThanOrEqual(456);
    await frame.locator('#room-toggle').press('Enter');
    await expect.poll(async () => (await hostBounds(page))!.height).toBeLessThanOrEqual(88);
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'outside';
      button.style.cssText = 'position:fixed;left:16px;bottom:150px;width:100px;height:30px';
      button.textContent = 'YouTube control';
      button.onclick = () => button.dataset.clicked = 'yes'; document.body.append(button);
    });
    await page.locator('#outside').click();
    await expect(page.locator('#outside')).toHaveAttribute('data-clicked', 'yes');
    const before = await hostBounds(page);
    await page.waitForTimeout(500);
    expect(await hostBounds(page)).toEqual(before);
  } finally { await driver.context.close(); }
});

test('title: обновления YouTube, совпадающий префикс, SPA, reload и выход через popup', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame, target } = await create(driver, 'Fixture');
    await page.evaluate(() => { document.title = 'Fixture | собственное название'; });
    await expect(page).toHaveTitle('Fixture | Fixture | собственное название');
    await page.evaluate(() => { document.querySelector('title')!.remove(); const title = document.createElement('title'); title.textContent = 'Новый заголовок'; document.head.append(title); });
    await expect(page).toHaveTitle('Fixture | Новый заголовок');
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=dQw4w9WgXcQ'); document.title = 'Другой ролик'; });
    await expect(page).toHaveTitle('Fixture | Другой ролик');
    await expect(frame.locator('#status')).toContainText('Локальный просмотр');
    await page.evaluate(() => { history.pushState({}, '', '/'); document.title = 'Главная'; });
    await expect(page).toHaveTitle('Главная');
    await expect.poll(() => panelVisibility(frame)).toBe('hidden');
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=dQw4w9WgXcQ'); document.title = 'Снова ролик'; });
    await expect(page).toHaveTitle('Fixture | Снова ролик');
    await expect.poll(() => panelVisibility(frame)).toBe('visible');
    // Popup не имеет права напрямую управлять presentation.
    const control = await popup(driver.context, page, driver.extensionId);
    await control.evaluate(`chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ type: 'room-presentation', target, sequence: 999999, visible: true, name: 'Подделка', width: 640, height: 400 })}, {frameId:0})).catch(() => null)`);
    await expect(page).toHaveTitle('Fixture | Снова ролик');
    await control.request(target, 'unwatch');
    await expect(page).toHaveTitle('Снова ролик');
    await expect.poll(() => panelVisibility(frame)).toBe('hidden');
    await control.close();
    await page.evaluate(() => { document.title = 'После выхода'; });
    await expect(page).toHaveTitle('После выхода');
    await page.reload();
    await expect(page).toHaveTitle('Shared playback fixture');
    expect(page.frames().some(frame => frame.url().includes('/session.html#'))).toBe(false);
  } finally { await driver.context.close(); }
});

test('гость: ссылка после reload/worker restart, отказ clipboard и локальные состояния без новых revision', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const before = await room();
    let frame = await frameOf(b, false);
    await frame.locator('#room-toggle').press('Escape');
    await expect(frame.locator('#room-details')).toBeHidden();
    await frame.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('Denied')) }); });
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#manual-invitation')).toBeVisible();
    await expect(frame.locator('#invitation-link')).toBeFocused();
    const invitation = await frame.locator('#invitation-link').inputValue();
    expect(new URL(invitation).hash.startsWith('#generation=emulator-v1&room=')).toBe(true);
    await b.reload(); frame = await frameOf(b, false);
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(b).toHaveTitle('Fixture | Shared playback fixture');
    await openDetails(frame);
    const stopped = await stopWorker(b.context(), b, await workerOf(b.context())); await stopped.detach();
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
    // Копирование работает без worker. Перед сменой network emulation
    // разбудим новый target: Playwright держит CDP-сессию старого worker.
    await frame.evaluate(target => chrome.runtime.sendMessage({ type: 'room-tab-catalog-status', backendGeneration: 'emulator-v1', target }), new URL(frame.url()).hash.slice(1));
    await b.context().grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
    expect(await b.evaluate(async link => (await navigator.clipboard.readText()) === link, invitation)).toBe(true);
    await b.context().setOffline(true);
    await expect(frame.locator('#status')).toContainText('Просмотр остаётся локальным.');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: —');
    await expect(b).toHaveTitle('Fixture | Shared playback fixture');
    await b.context().setOffline(false);
    await expect(frame.locator('#status')).toHaveText('Смотрим вместе');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: 2');
    await b.locator('#movie_player').evaluate(el => el.classList.add('ad-showing'));
    await expect(frame.locator('#status')).toContainText('Реклама');
    await b.locator('#movie_player').evaluate(el => el.classList.remove('ad-showing'));
    await expect(frame.locator('#status')).toHaveText('Смотрим вместе');
    await expect(frame.locator('#copy-status')).toBeHidden();
    const spinner = frame.locator('.buffering-spinner');
    const dockLayout = async () => {
      await settlePanel(frame);
      return [await panelBounds(frame), ...await Promise.all([
        '#room-dock', '#room-details', '#room-name', '#participant-count', '#copy-invitation', '#leave',
      ].map(selector => frame.locator(selector).boundingBox()))];
    };
    for (const expanded of [true, false]) {
      await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', String(expanded));
      const readyLayout = await dockLayout();
      await b.locator('video').evaluate(el => el.dispatchEvent(new Event('waiting')));
      await expect(spinner).toBeVisible();
      await expect(frame.locator('#room-toggle')).toHaveAttribute('title', /Видео загружается/);
      await expect(frame.locator('#announcement')).toContainText('Видео загружается');
      await expect(frame.locator('.summary')).toHaveCSS('clip-path', 'inset(50%)');
      await expect(frame.locator('#player-status')).toBeHidden();
      await expect(frame.locator('#synced-status')).toBeHidden();
      expect(await dockLayout()).toEqual(readyLayout);
      await b.locator('video').evaluate(el => el.dispatchEvent(new Event('canplay')));
      await expect(spinner).toBeHidden();
      await expect(frame.locator('#status')).toHaveText('Смотрим вместе');
      expect(await dockLayout()).toEqual(readyLayout);
      await frame.locator('#room-toggle').press('Enter');
    }
    expect((await room()).playback).toEqual(before.playback);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect(b).toHaveTitle('Shared playback fixture');
    await expect.poll(() => panelVisibility(frame)).toBe('hidden');
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(1);
    expect((await room()).playback).toEqual(before.playback);
    await expect((await frameOf(a)).locator('#participant-count')).toHaveText('Участников: 1');
  });
});

test('общая смена сохраняет имя и приглашение у создателя и гостя', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const copyFrom = async (page: Page) => {
      await page.bringToFront();
      const frame = await frameOf(page);
      await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
      await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
      await page.context().grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
      return page.evaluate(() => navigator.clipboard.readText());
    };
    const invitation = await copyFrom(a);
    expect(await copyFrom(b)).toBe(invitation);
    const before = (await room()).playback;
    await b.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(b);
    const frame = await frameOf(b);
    await frame.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: 'dQw4w9WgXcQ', revision: before.revision + 1 });
    await expect(a).toHaveURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    for (const page of [a, b]) {
      await expect(page).toHaveTitle('Fixture | Shared playback fixture');
      await expect((await frameOf(page)).locator('#room-name')).toHaveText('Fixture');
      expect(await copyFrom(page)).toBe(invitation);
    }
    expect((await room()).playback.revision).toBe(before.revision + 1);
  });
});

test('presentation: перестановка адресованных сообщений не возвращает очищенный UI', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame, target } = await create(driver, 'Fixture');
    const send = (sequence: number, visible: boolean) => frame.evaluate(async message => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab!.id!, message, { frameId: 0 });
    }, { type: 'room-presentation', target, sequence, visible, name: visible ? 'Fixture' : null, width: 320, height: 80 });
    await page.bringToFront();
    for (const invalid of [
      { target: crypto.randomUUID() }, { height: 99999 }, { key: 'forbidden' },
    ]) {
      await frame.evaluate(message => chrome.tabs.query({ active: true, currentWindow: true })
        .then(([tab]) => chrome.tabs.sendMessage(tab!.id!, message, { frameId: 0 })), {
          type: 'room-presentation', target, sequence: 99998, visible: false, name: null, width: 320, height: 80, ...invalid,
        });
      await expect(page).toHaveTitle('Fixture | Shared playback fixture');
    }
    await send(100000, false); await expect(page).toHaveTitle('Shared playback fixture');
    await send(99999, true); await expect(page).toHaveTitle('Shared playback fixture');
    const iframe = await frame.frameElement();
    expect(await iframe.evaluate(el => getComputedStyle(el as Element).visibility)).toBe('hidden');
    await send(100001, true); await expect(page).toHaveTitle('Fixture | Shared playback fixture');
  } finally { await driver.context.close(); }
});

test('удалённая запись каталога не возвращается при восстановлении ссылки из привязки', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const created = await create(driver, 'Fixture');
    const key = new URLSearchParams(new URL(created.invitation).hash.slice(1)).get('room')!;
    const control = await popup(driver.context, created.page, driver.extensionId);
    await control.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'remove', key })})`);
    await control.close();
    await created.page.reload();
    const frame = await frameOf(created.page);
    await expect(created.page).toHaveTitle('Fixture | Shared playback fixture');
    await openDetails(frame);
    await frame.getByRole('button', { name: 'Копировать приглашение' }).press('Enter');
    await expect(frame.locator('#copy-status')).toHaveText('Приглашение скопировано.');
    await driver.context.grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
    expect(await created.page.evaluate(async link => (await navigator.clipboard.readText()) === link, created.invitation)).toBe(true);
    const check = await popup(driver.context, created.page, driver.extensionId);
    const entries = await check.evaluate<{ entries: unknown[] }>(`chrome.runtime.sendMessage({type:'room-catalog',backendGeneration:'emulator-v1',action:'list'})`);
    expect(entries.entries).toEqual([]);
    await check.close();
  } finally { await driver.context.close(); }
});

test('ошибка presence убирает число, сохраняет выход и восстанавливается повтором без revision', async () => {
  const driver = await setup(false, playerFixture());
  let deny = true;
  try {
    await driver.context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, socket => {
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (deny && packet?.d?.a === 'o' && packet.d.b?.p?.includes('/presence/')) {
          socket.send(JSON.stringify({ t: 'd', d: { r: packet.d.r, b: { s: 'permission_denied', d: 'Denied for UI test' } } }));
        } else server.send(message);
      });
    });
    const { page, frame } = await create(driver, 'Fixture');
    await expect(frame.locator('#status')).toContainText('Не удалось обновить присутствие');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: —');
    await openDetails(frame);
    await expect(frame.locator('#participants')).toBeHidden();
    await expect(frame.getByRole('button', { name: 'Выйти из комнаты' })).toBeEnabled();
    const playback = await sessionPlayback(frame);
    deny = false;
    await frame.getByRole('button', { name: 'Повторить подключение', exact: true }).press('Enter');
    await expect(frame.locator('#participant-count')).toHaveText('Участников: 1');
    await expect(frame.locator('#status')).toHaveText('Смотрим вместе');
    expect(await sessionPlayback(frame)).toEqual(playback);
    await expect(page).toHaveTitle('Fixture | Shared playback fixture');
  } finally { await driver.context.close(); }
});

test('отказ release оставляет привязку, title и явную ошибку; повтор очищает UI', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame } = await create(driver, 'Fixture');
    await openDetails(frame);
    const playback = await sessionPlayback(frame);
    await driver.worker.evaluate(() => {
      const original = chrome.storage.session.set.bind(chrome.storage.session);
      Object.assign(globalThis, { qaRestoreRelease: () => { chrome.storage.session.set = original; } });
      chrome.storage.session.set = async values => {
        const bindings = (values as Record<string, unknown>)['roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]'];
        if (bindings && Object.values(bindings).some((binding: unknown) => {
          const item = binding as { target?: string; key?: string }; return item.target && !item.key;
        })) throw new Error('Denied for UI test');
        return original(values);
      };
    });
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect(frame.locator('#action-status')).toContainText('Не удалось выйти');
    await expect(frame.locator('#problem')).toBeVisible();
    await expect(page).toHaveTitle('Fixture | Shared playback fixture');
    expect(await panelVisibility(frame)).toBe('visible');
    expect(await sessionPlayback(frame)).toEqual(playback);
    await driver.worker.evaluate(() => (globalThis as typeof globalThis & { qaRestoreRelease: () => void }).qaRestoreRelease());
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect.poll(() => panelVisibility(frame)).toBe('hidden');
    await expect(page).toHaveTitle('Shared playback fixture');
    await page.reload();
    expect(page.frames().some(frame => frame.url().includes('/session.html#'))).toBe(false);
  } finally { await driver.context.close(); }
});

test('ошибка возврата видна в подробностях и не подтверждает синхронизацию или новую revision', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const initial = (await room()).playback;
    await b.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await readyPlayer(b);
    const frame = await frameOf(b);
    await expect(frame.locator('#status')).toContainText('Локальный просмотр');
    const worker = await workerOf(b.context());
    await worker.evaluate(() => {
      const original = chrome.tabs.update.bind(chrome.tabs);
      Object.assign(globalThis, { qaRestoreReturn: () => { chrome.tabs.update = original; } });
      chrome.tabs.update = async () => { throw new Error('Denied for UI test'); };
    });
    const back = frame.getByRole('link', { name: 'Вернуться в комнату' });
    await back.press('Enter');
    await expect(frame.locator('#action-status')).toHaveText('Не удалось обновить просмотр. Повторите действие.');
    await expect(frame.locator('#problem')).toBeVisible();
    await expect(frame.locator('#status')).not.toHaveText('Смотрим вместе');
    await expect(back).toBeVisible();
    await expect(b).toHaveURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect((await room()).playback).toEqual(initial);
    await worker.evaluate(() => (globalThis as typeof globalThis & { qaRestoreReturn: () => void }).qaRestoreReturn());
    // Незавершённый force-return повторяется существующим reconcile timer.
    await expect(b).toHaveURL(watch);
    await expect((await frameOf(b)).locator('#status')).toHaveText('Смотрим вместе');
    expect((await room()).playback).toEqual(initial);
    await expect((await frameOf(a)).locator('#participant-count')).toHaveText('Участников: 2');
  });
});

test('нормализация пробелов HTML title не размножает префикс и не мешает выходу', async () => {
  const driver = await setup(false, playerFixture());
  try {
    const { page, frame } = await create(driver, 'Имя  \n комнаты');
    await expect(page).toHaveTitle('Имя комнаты | Shared playback fixture');
    await page.waitForTimeout(500);
    await expect(page).toHaveTitle('Имя комнаты | Shared playback fixture');
    await openDetails(frame);
    await frame.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect(page).toHaveTitle('Shared playback fixture');
    await expect.poll(() => panelVisibility(frame)).toBe('hidden');
  } finally { await driver.context.close(); }
});
