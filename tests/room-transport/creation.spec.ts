import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { admin, frameOf, popup, setup, watch } from './fixtures';

// Настоящий HTMLMediaElement с локальным seekable ресурсом, без внешней сети.
function playerFixture() {
  const length = 120 * 8000;
  const wav = Buffer.alloc(44 + length, 128);
  wav.write('RIFF'); wav.writeUInt32LE(36 + length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(length, 40);
  return `<!doctype html><title>Room creation fixture</title><div id="movie_player">
    <video class="html5-main-video" preload="auto" src="data:audio/wav;base64,${wav.toString('base64')}"></video>
  </div>`;
}

async function preparePlayer(page: Page, isPlaying: boolean) {
  await page.goto(watch);
  await page.locator('video').evaluate(async (video: HTMLVideoElement, playing) => {
    if (video.readyState < 3) await new Promise(resolve => video.addEventListener('canplay', resolve, { once: true }));
    video.currentTime = 7.5;
    video.playbackRate = 1.5;
    video.volume = 0.3;
    if (playing) await video.play();
  }, isPlaying);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
}

async function click(control: Awaited<ReturnType<typeof popup>>, label: string) {
  // Состояние transport может обновиться раньше очередного render popup.
  const button = `Array.from(document.querySelectorAll('button')).find(button => (button.getAttribute('aria-label') ?? button.textContent) === ${JSON.stringify(label)})`;
  await expect.poll(() => control.evaluate<boolean>(`${button}?.disabled === false`)).toBe(true);
  await control.evaluate(`${button}.click(); true`);
}

for (const isPlaying of [false, true]) test(`popup создаёт комнату и копирует приглашение: ${isPlaying ? 'play' : 'pause'}`, async () => {
  const { context, extensionId } = await setup(false, playerFixture());
  try {
    const page = await context.newPage();
    await preparePlayer(page, isPlaying);
    let control = await popup(context, page, extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await expect.poll(() => control.evaluate<boolean>("!Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Смотреть вместе')?.disabled")).toBe(true);
    const sampledPosition = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime);
    const startedAt = Date.now();
    await click(control, 'Смотреть вместе');
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    const state = await control.request(target);
    expect(state.creationError).toBeNull();
    expect(state.creating).toBe(false);
    const invitation = new URL(state.invitation!);
    expect(invitation.origin).toBe('http://127.0.0.1:5002');
    expect(invitation.pathname + invitation.search).toBe('/');
    const key = new URLSearchParams(invitation.hash.slice(1)).get('room')!;
    expect(/^[a-f0-9]{64}$/.test(key)).toBe(true);
    // Серверное чтение не принимает optimistic cache SDK за подтверждённую запись.
    const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, { headers: { Authorization: 'Bearer owner' } });
    expect(response.ok).toBe(true);
    const room = await response.json();
    expect(Object.keys(room).every(key => key === 'playback' || key === 'presence' || key === 'metadata')).toBe(true);
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    expect(room.metadata).toEqual({ name: expect.stringMatching(/^🎬 \d{4}$/u), createdWithVersion: version, backendGeneration: 'emulator-v1' });
    await expect(page).toHaveTitle(`${room.metadata.name} | Room creation fixture`);
    expect(Object.keys(room.playback).sort()).toEqual(['actionAt', 'actorUid', 'commandId', 'isPlaying', 'kind', 'playbackRate', 'positionSeconds', 'revision', 'sampledAt', 'updatedAt', 'videoId', 'videoRevision']);
    expect(room.playback).toMatchObject({ videoId: 'aqz-KE-bpKQ', playbackRate: 1.5, isPlaying, revision: 0, actorUid: state.uid });
    expect(room.playback.actionAt).toBe(room.playback.updatedAt);
    expect(room.playback.sampledAt).toBe(room.playback.updatedAt);
    expect(room.playback.updatedAt).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(room.playback.updatedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(room.playback.positionSeconds).toBeGreaterThanOrEqual(sampledPosition);
    if (!isPlaying) expect(room.playback.positionSeconds).toBe(7.5);
    else expect(room.playback.positionSeconds).toBeLessThan(sampledPosition + (Date.now() - startedAt) / 1000 * 1.5 + 0.2);
    // Секрет не попадает ни в DOM страницы, ни в URL iframe.
    expect((await page.content()).includes(key)).toBe(false);
    expect(frame.url().includes(key)).toBe(false);
    await expect(frame.locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем/);
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain(room.metadata.name);
    expect(await control.evaluate<boolean>("!!document.querySelector('input[readonly]')")).toBe(false);
    await click(control, 'Копировать приглашение');
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Приглашение скопировано.');
    // Повтор запроса и повторное открытие popup возвращают ту же комнату.
    const repeated = await control.request(target, 'create', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 99, playbackRate: 2, isPlaying: !isPlaying } });
    expect(repeated.invitation === state.invitation).toBe(true);
    await control.close();
    // Читаем настоящий системный clipboard из тестовой HTTPS-страницы.
    // Chrome не выдаёт clipboard-read для chrome-extension origin через CDP.
    await context.grantPermissions(['clipboard-read'], { origin: 'https://www.youtube.com' });
    await page.bringToFront();
    expect(await page.evaluate(async (invitation) => (await navigator.clipboard.readText()) === invitation, state.invitation)).toBe(true);
    control = await popup(context, page, extensionId);
    await control.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError'))
    }); true`);
    await click(control, 'Копировать приглашение');
    await expect.poll(() => control.evaluate<boolean>(`(() => {
      const field = document.querySelector('input[readonly]');
      return !!field && field === document.activeElement && field.value === ${JSON.stringify(state.invitation)}
        && field.selectionStart === 0 && field.selectionEnd === field.value.length;
    })()`)).toBe(true);
    await control.close();
  } finally { await context.close(); }
});

test('реклама, неготовое видео и отказ записи не выдают приглашение; повтор после отказа работает', async () => {
  const { context, extensionId } = await setup(false, playerFixture());
  try {
    const page = await context.newPage();
    await preparePlayer(page, false);
    const control = await popup(context, page, extensionId);
    const target = new URL((await frameOf(page)).url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    await page.locator('#movie_player').evaluate(player => player.classList.add('ad-showing'));
    await click(control, 'Смотреть вместе');
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Дождитесь окончания рекламы');
    expect((await control.request(target)).invitation).toBeNull();
    await page.locator('#movie_player').evaluate(player => player.classList.remove('ad-showing'));
    await page.locator('video').evaluate((video: HTMLVideoElement) => { video.removeAttribute('src'); video.load(); });
    await click(control, 'Смотреть вместе');
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Дождитесь готовности');
    expect((await control.request(target)).invitation).toBeNull();
    // Не ослабляем продуктовые Rules: временно полностью запрещаем запись.
    await page.locator('#movie_player').evaluate((player, html) => { player.outerHTML = html; }, playerFixture().slice(playerFixture().indexOf('<div')));
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 3)).toBe(true);
    await admin('.settings/rules', { rules: { '.read': false, '.write': false } });
    await click(control, 'Смотреть вместе');
    await expect.poll(async () => (await control.request(target)).creationError).toContain('Не удалось создать комнату');
    expect((await control.request(target)).invitation).toBeNull();
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
    await click(control, 'Смотреть вместе');
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    await control.close();
  } finally {
    await context.close();
    await admin('.settings/rules', JSON.parse(await readFile('firebase/emulator.database.rules.json', 'utf8')));
  }
});

test('настоящий YouTube: комната из текущего состояния через popup', async () => {
  test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  const { context, extensionId } = await setup(true);
  try {
    const page = await context.newPage();
    await page.goto(`${watch}&hl=en`, { waitUntil: 'domcontentloaded' });
    const video = page.locator('#movie_player video.html5-main-video').first();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) =>
      element.readyState >= 3 && Number.isFinite(element.duration)
      && !element.closest('.ad-showing, .ad-interrupting')), { timeout: 40_000 }).toBe(true);
    await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.playbackRate = 1.25; });
    const control = await popup(context, page, extensionId);
    const frame = await frameOf(page);
    const target = new URL(frame.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const position = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    await click(control, 'Смотреть вместе');
    await expect.poll(async () => !!(await control.request(target)).invitation).toBe(true);
    await expect.poll(async () => (await control.request(target)).room).toMatchObject({ playback: {
      videoId: 'aqz-KE-bpKQ', positionSeconds: position, playbackRate: 1.25, isPlaying: false, revision: 0,
    } });
    await expect(frame.locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем/);
    await click(control, 'Копировать приглашение');
    await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Приглашение скопировано.');
    await control.close();
  } finally { await context.close(); }
});
