import { test, expect } from '@playwright/test';
import { readyPlayer, sample, withPlaybackPair } from './playback-fixture';

test('удержание клавиши защищено от remote seek; отпускание публикует последнее действие без эха', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    await b.locator('#movie_player').focus();
    await b.keyboard.down('ArrowRight');
    await b.waitForTimeout(400);
    expect((await room()).playback.revision).toBe(0);
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(1);
    await b.waitForTimeout(250);
    expect((await sample(b)).positionSeconds).toBe(15);
    await b.keyboard.down('ArrowRight');
    await b.keyboard.down('ArrowRight');
    await b.waitForTimeout(250);
    expect((await room()).playback.revision).toBe(1);
    expect((await sample(b)).positionSeconds).toBe(25);
    await b.keyboard.up('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(2);
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds: 25, isPlaying: false });
    await b.waitForTimeout(600);
    expect((await room()).playback.revision).toBe(2);
  });
});

test('отпускание ползунка после чужой перемотки становится последним действием', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const bar = (await b.locator('.ytp-progress-bar').boundingBox())!;
    await b.mouse.move(bar.x + 5, bar.y + 5);
    await b.mouse.down();
    await b.mouse.move(bar.x + 200, bar.y + 5);
    await expect.poll(async () => (await sample(b)).positionSeconds).toBe(30);
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(1);
    await b.waitForTimeout(250);
    expect((await sample(b)).positionSeconds).toBe(30);
    await b.mouse.up();
    await expect.poll(async () => (await room()).playback.revision).toBe(2);
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds: 30, isPlaying: false });
    await b.waitForTimeout(600);
    expect((await room()).playback.revision).toBe(2);
  });
});

for (const remoteLater of [false, true]) test(`задержанная отправка: ${remoteLater ? 'более позднее действие другого участника' : 'последняя локальная позиция без отката'}`, async () => {
  let armed = false;
  let release: (() => void) | undefined;
  let writes = 0;
  await withPlaybackPair(async ({ a, b, room }) => {
    armed = true;
    await b.locator('#movie_player').focus();
    await b.keyboard.press('ArrowRight');
    await expect.poll(() => !!release).toBe(true);
    const recordSeeks = async () => b.locator('video').evaluate((video: HTMLVideoElement) => {
      const observed: number[] = [];
      (window as unknown as { observedSeeks: number[] }).observedSeeks = observed;
      video.addEventListener('seeking', () => observed.push(video.currentTime));
    });
    try {
      if (remoteLater) {
        await a.locator('#movie_player').focus();
        await a.keyboard.press('ArrowRight');
        await a.keyboard.press('ArrowRight');
        await expect.poll(async () => (await room()).playback.revision).toBe(1);
        expect((await room()).playback.positionSeconds).toBe(20);
      } else {
        // Два завершённых действия, пока первая транзакция ещё ждёт сервера.
        await b.keyboard.press('ArrowRight');
        await b.waitForTimeout(250);
        await b.keyboard.press('ArrowRight');
        await b.waitForTimeout(250);
        expect(writes).toBe(1);
        expect((await sample(b)).positionSeconds).toBe(25);
        await readyPlayer(b);
        await recordSeeks();
      }
    } finally { release!(); }
    const positionSeconds = remoteLater ? 20 : 25;
    const revision = remoteLater ? 1 : 2;
    await expect.poll(async () => (await room()).playback.revision).toBe(revision);
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds, isPlaying: false });
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(revision);
    if (!remoteLater) {
      expect(writes).toBe(2);
      expect(await b.evaluate(() => (window as unknown as { observedSeeks: number[] }).observedSeeks)).not.toContain(15);
    }
  }, async context => {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
          writes++;
          if (armed) {
            armed = false;
            release = () => server.send(message);
            return;
          }
        }
        server.send(message);
      });
    });
  });
});
