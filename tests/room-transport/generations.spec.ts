import { expect, test } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { launchExtension } from '../e2e/fixtures';
import { admin, frameOf, popup, sessionPlayback, setup, stopWorker, watch } from './fixtures';
import { playerFixture, readyPlayer } from './playback-fixture';
declare const chrome: typeof browserApi;

const localControl = 'http://127.0.0.1:5002';
const fixtureControl = 'https://fixture-control.web.app';
const registry = (retired = false) => {
  const now = new Date().toISOString();
  return { schemaVersion: 1, revision: 2, updatedAt: now, generations: [
    { generation: 'g-fixture', firstRelease: '0.3.0', state: 'active' },
    retired ? { generation: 'emulator-v1', firstRelease: '0.2.0', state: 'retired', retiredAt: now }
      : { generation: 'emulator-v1', firstRelease: '0.2.0', state: 'active' },
  ] };
};
const joinFrame = async (page: import('@playwright/test').Page) => {
  await expect.poll(() => page.frames().find(frame => frame.url().includes('/invitation.html#'))).toBeTruthy();
  const frame = page.frames().find(item => item.url().includes('/invitation.html#'))!;
  await expect(frame.locator('#join')).toBeVisible();
  await frame.locator('#join').press('Enter');
  return frame;
};

test('чужое поколение в обоих направлениях отвергается до Auth и базы', async () => {
  const fixturePath = process.env.GENERATION_FIXTURE_EXTENSION;
  test.skip(!fixturePath, 'Нужна изолированная release fixture 0.3.0 g-fixture.');
  const local = await setup();
  const fixture = await launchExtension(fixturePath!);
  try {
    const secret = randomBytes(32).toString('hex');
    for (const [context, control, invited, message] of [
      [local.context, localControl, 'g-fixture', 'нужна более новая версия'],
      [fixture, fixtureControl, 'emulator-v1', 'не поддерживает поколение комнаты'],
    ] as const) {
      let backendRequests = 0;
      const page = await context.newPage();
      context.on('request', request => {
        if (/:(9000|9099)\/|identitytoolkit|securetoken|firebaseio|firebasedatabase/.test(request.url())) backendRequests++;
      });
      page.on('websocket', socket => { if (/9000|firebase/.test(socket.url())) backendRequests++; });
      await context.route(`${control}/backend-generations.json`, route => route.fulfill({ json: registry(),
        headers: { 'Access-Control-Allow-Origin': '*' } }));
      if (control === fixtureControl) {
        await context.route(`${control}/`, async route => route.fulfill({
          contentType: 'text/html', body: await readFile('firebase/hosting/index.html', 'utf8'),
        }));
        await context.route(`${control}/*.{js,css}`, route => route.abort());
      }
      await page.goto(`${control}/#generation=${invited}&room=${secret}`);
      const frame = await joinFrame(page);
      await expect(frame.locator('#status')).toContainText(message);
      await expect(frame.locator('#join')).toBeHidden();
      expect(backendRequests).toBe(0);
    }
  } finally { await fixture.close(); await local.context.close(); }
});

test('retired выигрывает у busy и блокирует приглашение и popup до Auth, REST и сокета', async () => {
  const { context, extensionId } = await setup(false, playerFixture());
  try {
    let backendRequests = 0;
    context.on('request', request => { if (/:(9000|9099)\//.test(request.url())) backendRequests++; });
    await context.route(`${localControl}/backend-generations.json`, route => route.fulfill({ json: registry(true) }));
    const now = Date.now();
    await context.route(`${localControl}/generations/emulator-v1/service-status.json`, route => route.fulfill({
      json: { version: 1, state: 'busy', retryAfterSeconds: 60, updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString() },
    }));
    const invitation = await context.newPage();
    invitation.on('websocket', () => backendRequests++);
    await invitation.goto(`${localControl}/#generation=emulator-v1&room=${randomBytes(32).toString('hex')}`);
    const frame = await joinFrame(invitation);
    await expect(frame.locator('#status')).toContainText('Поддержка этой комнаты завершена');
    await expect(frame.locator('#join')).toBeHidden();
    const page = await context.newPage();
    page.on('websocket', () => backendRequests++);
    await page.goto(watch);
    const control = await popup(context, page, extensionId);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Поддержка этой комнаты завершена');
    expect(await control.evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent === 'Повторить')`)).toBe(false);
    expect(await control.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Смотреть вместе')?.disabled`)).toBe(true);
    await control.close();
    expect(backendRequests).toBe(0);
  } finally { await context.close(); }
});

test('unknown допускает вход в своё поколение и комнату совместимого patch', async () => {
  const { context } = await setup();
  try {
    const secret = randomBytes(32).toString('hex');
    await admin(`rooms/${secret}`, {
      metadata: { name: 'Patch fixture', createdWithVersion: '0.2.1', backendGeneration: 'emulator-v1' },
      playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 2, playbackRate: 1, isPlaying: false, revision: 0,
        kind: 'playback', videoRevision: 0, actorUid: 'fixture', commandId: 'fixture', updatedAt: 1, actionAt: 1, sampledAt: 1 },
    });
    await context.route(`${localControl}/backend-generations.json`, route => route.fulfill({ status: 503 }));
    const page = await context.newPage();
    await page.goto(`${localControl}/#generation=emulator-v1&room=${secret}`);
    const invitation = await joinFrame(page);
    await expect(invitation.locator('#status')).toContainText('Комната открыта');
    const guest = () => context.pages().find(candidate => candidate.url() === watch);
    await expect.poll(guest).toBeTruthy();
    const session = await frameOf(guest()!);
    await expect.poll(() => sessionPlayback(session)).toMatchObject({ positionSeconds: 2, revision: 0 });
  } finally { await context.close(); }
});

test('новый namespace не читает прежние комнаты и bindings; позднее сообщение чужого поколения отвергается', async () => {
  const profile = await setup();
  try {
    const driver = await profile.context.newPage();
    await driver.goto(`chrome-extension://${profile.extensionId}/popup.html`);
    await driver.evaluate(async () => {
      await chrome.storage.local.set({ 'roomCatalog:old': { version: 1, entries: [{ key: 'a'.repeat(64), name: 'Старая комната' }] } });
      await chrome.storage.session.set({ roomTabBindingsV2: { '1': { target: crypto.randomUUID(), key: 'a'.repeat(64), name: 'Старая комната' } } });
    });
    const list = () => driver.evaluate(() => chrome.runtime.sendMessage({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'list' }));
    expect((await list()).entries).toEqual([]);
    const network: string[] = [];
    profile.context.on('request', request => { if (/:(9000|9099)\//.test(request.url())) network.push(request.method()); });
    const page = await profile.context.newPage(); await page.goto(watch); await page.reload();
    await (await stopWorker(profile.context, page, profile.worker)).detach();
    await page.reload();
    expect(page.frames().filter(frame => frame.url().includes('/session.html'))).toHaveLength(0);
    const response = await driver.evaluate(() => chrome.runtime.sendMessage({ type: 'room-catalog', backendGeneration: 'other', action: 'open',
      room: { key: 'a'.repeat(64), name: 'Чужая комната', videoId: 'aqz-KE-bpKQ', backendGeneration: 'other' } }));
    expect(response).toBeUndefined(); expect((await list()).entries).toEqual([]);
    expect(network).toEqual([]);
    expect(profile.context.pages().filter(item => item.url() === watch)).toHaveLength(1);
    await driver.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await page.reload();
    expect(page.frames().filter(frame => frame.url().includes('/session.html'))).toHaveLength(0);
    expect(network).toEqual([]);
  } finally { await profile.context.close(); }
});

test('runtime invalidation останавливает активный просмотр; после reload старый target не управляет новой сессией', async () => {
  const profile = await setup(false, playerFixture());
  try {
    const page = await profile.context.newPage(); await page.goto(watch); await readyPlayer(page);
    let control = await popup(profile.context, page, profile.extensionId);
    let frame = await frameOf(page);
    const oldTarget = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(oldTarget)).connected).toBe(true);
    const created = await control.request(oldTarget, 'create', {
      metadata: { name: 'Runtime lifecycle', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' },
      playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 0, isPlaying: false, playbackRate: 1 },
    });
    expect(created.invitation).toBeTruthy();
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    const room = async () => {
      const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, { headers: { Authorization: 'Bearer owner' } });
      expect(response.ok).toBe(true); return response.json();
    };
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(1);
    await control.close();
    // Совместимый reload сохраняет свою комнату и выдаёт новый target.
    await page.reload(); await readyPlayer(page);
    frame = await frameOf(page); const currentTarget = new URL(frame.url()).hash.slice(1);
    expect(currentTarget).not.toBe(oldTarget);
    control = await popup(profile.context, page, profile.extensionId);
    await expect.poll(async () => (await control.request(currentTarget)).roomReady).toBe(true);
    expect(await control.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'room-session', backendGeneration: 'emulator-v1', target: oldTarget, action: 'watch', key: 'b'.repeat(64) })})`)).toBeUndefined();
    expect((await control.request(currentTarget)).roomReady).toBe(true);
    await control.close();
    const before = (await room()).playback;
    const driver = await profile.context.newPage();
    await driver.goto(`chrome-extension://${profile.extensionId}/popup.html`);
    await page.bringToFront();
    await driver.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await expect.poll(() => page.frames().some(item => item.url().includes('/session.html'))).toBe(false);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(0);
    // Локальные действия после выгрузки runtime не отправляются в прежнюю комнату.
    await page.locator('.ytp-progress-bar').click();
    await page.locator('.ytp-play-button').click();
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
    expect((await room()).playback).toEqual(before);
    expect(profile.context.pages().filter(item => item.url() === watch)).toHaveLength(1);
  } finally { await profile.context.close(); }
});
