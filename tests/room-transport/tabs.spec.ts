import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { admin, frameOf, sessionPlayback, setup, watch } from './fixtures';

declare const chrome: typeof browserApi;

async function invitationFrame(page: Page) {
  await expect.poll(() => page.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
  return page.frames().find(f => f.url().includes('/invitation.html#'))!;
}

test('одновременные приглашения, закрытие вкладки и выход не создают лишних подключений', async () => {
  const { context, extensionId } = await setup();
  const key = randomBytes(32).toString('hex');
  const invitation = `http://127.0.0.1:5002/#generation=emulator-v1&room=${key}`;
  async function connections() {
    const response = await fetch(`http://127.0.0.1:9000/rooms/${key}/presence.json?ns=demo-watch-together-default-rtdb`, {
      headers: { Authorization: 'Bearer owner' },
    });
    expect(response.ok).toBe(true);
    const presence = await response.json();
    return Object.values(presence ?? {}).reduce<number>((n, p: any) => n + Object.keys(p.connections).length, 0);
  }
  try {
    await admin(`rooms/${key}`, { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
      videoId: 'aqz-KE-bpKQ', positionSeconds: 9, playbackRate: 1, isPlaying: false,
      revision: 0, kind: 'playback' as const, videoRevision: 0, actionAt: Date.now(), sampledAt: Date.now(), updatedAt: Date.now(), actorUid: 'fixture', commandId: 'initial',
    } });
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([a.goto(invitation), b.goto(invitation)]);
    const frames = await Promise.all([invitationFrame(a), invitationFrame(b)]);
    await Promise.all(frames.map(f => f.getByRole('button', { name: 'Присоединиться' }).click()));
    for (const frame of frames) await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    expect(context.pages().filter(p => p.url() === watch)).toHaveLength(1);
    const page = context.pages().find(p => p.url() === watch)!;
    const session = await frameOf(page);
    await expect.poll(() => sessionPlayback(session)).toMatchObject({ positionSeconds: 9 });
    await expect.poll(connections).toBe(1);
    // Страница не может создать ещё один подписанный session iframe сама.
    const spoofTarget = await page.evaluate(extensionId => {
      const target = crypto.randomUUID();
      const iframe = document.createElement('iframe');
      iframe.src = `chrome-extension://${extensionId}/session.html#${target}`;
      document.body.append(iframe);
      return target;
    }, extensionId);
    await expect.poll(() => page.frames().some(f => f.url().endsWith(spoofTarget))).toBe(true);
    const spoof = page.frames().find(f => f.url().endsWith(spoofTarget))!;
    await expect(spoof.locator('[role="status"]')).toHaveText('Подключено. Комната ещё не выбрана.');
    await expect(spoof.locator('#participants')).toBeHidden();
    await expect.poll(connections).toBe(1);
    await page.close();
    await expect.poll(connections).toBe(0);
    // После закрытия открывается новая вкладка с единственным соединением.
    const replacementEvent = context.waitForEvent('page');
    await frames[0].getByRole('button', { name: 'Открыть вкладку комнаты' }).click();
    const replacement = await replacementEvent;
    const restored = await frameOf(replacement);
    await expect.poll(connections).toBe(1);
    await restored.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect(restored.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    await expect.poll(connections).toBe(0);
    await replacement.reload();
    await expect(replacement.locator('iframe')).toHaveCount(0);
    // Привязка удалена до reload; загрузка страницы её не воссоздаёт.
    const bindings = await frames[0].evaluate(async () => (await chrome.storage.session.get('roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]'))['roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]']);
    expect(Object.values(bindings ?? {}).some((binding: any) => binding.key === key)).toBe(false);
  } finally { await context.close(); }
});

test('настоящий YouTube: приглашение открывает связанную вкладку и повторно активирует её', async () => {
  test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  const { context } = await setup(true);
  const key = randomBytes(32).toString('hex');
  try {
    await admin(`rooms/${key}`, { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
      videoId: 'aqz-KE-bpKQ', positionSeconds: 12, playbackRate: 1.5, isPlaying: false,
      revision: 0, kind: 'playback' as const, videoRevision: 0, actionAt: Date.now(), sampledAt: Date.now(), updatedAt: Date.now(), actorUid: 'fixture', commandId: 'initial',
    } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5002/#generation=emulator-v1&room=${key}`);
    const frame = await invitationFrame(page);
    const opened = context.waitForEvent('page');
    await frame.getByRole('button', { name: 'Присоединиться' }).click();
    const viewing = await opened;
    await expect(viewing).toHaveURL(watch);
    const session = await frameOf(viewing);
    await expect.poll(() => sessionPlayback(session)).toMatchObject({ positionSeconds: 12, playbackRate: 1.5, isPlaying: false });
    await expect(session.getByRole('listitem')).toHaveText(['Участник 1 (вы)']);
    await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    await frame.getByRole('button', { name: 'Открыть вкладку комнаты' }).click();
    await expect(frame.locator('[role="status"]')).toHaveText('Комната открыта во вкладке YouTube.');
    expect(context.pages().filter(p => p.url() === watch)).toHaveLength(1);
    const active = await frame.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url);
    expect(active).toBe(watch);
  } finally { await context.close(); }
});
