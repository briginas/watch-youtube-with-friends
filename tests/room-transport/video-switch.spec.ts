import { test, expect, type Page } from '@playwright/test';
import { frameOf, stopWorker, watch, workerOf } from './fixtures';
import { readyPlayer, sample, withPlaybackPair } from './playback-fixture';

const next = 'dQw4w9WgXcQ';
const other = 'M7lc1UVf-VE';
const url = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
// Свойства JS-wrapper из MAIN world не видны isolated content script.
// Ограничения media задаём в его настоящем execution context, без API продукта.
async function restrictSnapshot(page: Page, kind: string) {
  const cdp = await page.context().newCDPSession(page);
  const contexts: { id: number; auxData?: { isDefault?: boolean } }[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  try {
    await cdp.send('Runtime.enable');
    let world: number | undefined;
    for (const context of contexts.filter(c => !c.auxData?.isDefault)) {
      const result = await cdp.send('Runtime.evaluate', { contextId: context.id,
        expression: '!!globalThis.chrome?.runtime?.id', returnByValue: true });
      if (result.result.value === true) { world = context.id; break; }
    }
    expect(world).toBeDefined();
    const result = await cdp.send('Runtime.evaluate', { contextId: world,
      expression: `(${((kind: string) => {
        const video = document.querySelector<HTMLVideoElement>('video')!;
        if (kind === 'unavailable') video.parentElement!.insertAdjacentHTML('beforeend', '<div class="ytp-error-content-wrap">Error</div>');
        else Object.defineProperty(video, kind === 'buffering' ? 'readyState' : kind === 'live' ? 'duration' : 'seeking', {
          configurable: true, get: () => kind === 'buffering' ? 2 : kind === 'live' ? Infinity : true,
        });
      }).toString()})(${JSON.stringify(kind)})` });
    expect(result.exceptionDetails).toBeUndefined();
  } finally { await cdp.detach(); }
}
async function propose(page: import('@playwright/test').Page, videoId: string, position = 22) {
  await page.goto(url(videoId));
  await readyPlayer(page);
  await page.locator('video').evaluate((video: HTMLVideoElement, at) => { video.currentTime = at; }, position);
  await readyPlayer(page);
  const session = await frameOf(page);
  await expect(session.getByRole('button', { name: 'Смотреть это в комнате', exact: true })).toBeVisible();
  await session.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
  await expect(session.locator('#switch-status')).not.toBeEmpty();
}

test('смена от обоих участников: одна комната, прежние вкладки и одна revision без эха', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const tabs = [a.context().pages().length, b.context().pages().length];
    const original = await room();
    const uid = original.playback.actorUid;
    await propose(a, next);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: next, revision: 1, videoRevision: 1, kind: 'switch-video', actorUid: uid });
    await expect(b).toHaveURL(url(next));
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds: 22, isPlaying: false, playbackRate: 1 });
    await propose(b, other, 35);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: other, revision: 2, videoRevision: 2 });
    expect((await room()).playback.actorUid).not.toBe(uid);
    await expect(a).toHaveURL(url(other));
    for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds: 35, isPlaying: false });
    expect([a.context().pages().length, b.context().pages().length]).toEqual(tabs);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(2);
    await a.locator('#movie_player').focus();
    await a.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(3);
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 40, isPlaying: false });
  });
});

test('локальный ролик и reload не следуют за комнатой; явный возврат получает последнюю revision', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    await b.goto(url(other));
    await readyPlayer(b);
    await b.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 44; });
    await propose(a, next);
    await expect.poll(async () => (await room()).playback.revision).toBe(1);
    await b.waitForTimeout(600);
    await expect(b).toHaveURL(url(other));
    expect((await sample(b)).positionSeconds).toBe(44);
    await b.reload();
    const session = await frameOf(b);
    await expect(session.locator('#player-status')).toContainText('Не синхронизируется');
    await expect(b).toHaveURL(url(other));
    await session.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect(b).toHaveURL(url(next));
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 22, isPlaying: false });
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(1);
    await b.goto(url(other));
    await frameOf(b);
    await b.goto(url(next));
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 22 });
    await expect((await frameOf(b)).getByRole('link', { name: 'Вернуться в комнату' })).toBeHidden();
    expect((await room()).playback.revision).toBe(1);
  });
});

test('совпадение локального видео с новой целью не применяет общую позицию; предложение и возврат A → B → A', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    await b.goto(url(next));
    await readyPlayer(b);
    await b.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 44; });
    await propose(a, next);
    await expect.poll(async () => (await room()).playback.videoRevision).toBe(1);
    await b.waitForTimeout(650);
    expect((await sample(b)).positionSeconds).toBe(44);
    const session = await frameOf(b);
    await session.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 22 });
    await propose(b, new URL(watch).searchParams.get('v')!, 12);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: new URL(watch).searchParams.get('v'), videoRevision: 2, revision: 2 });
    await expect(a).toHaveURL(watch);
    await expect.poll(() => sample(a)).toMatchObject({ positionSeconds: 12 });
  });
});

test('неготовый плеер и offline не меняют общее видео и не создают отложенную смену', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    await b.goto(url(next));
    await readyPlayer(b);
    const session = await frameOf(b);
    const button = session.getByRole('button', { name: 'Смотреть это в комнате', exact: true });
    await expect(button).toBeEnabled();
    await b.locator('#movie_player').evaluate(el => el.classList.add('ad-showing'));
    await button.press('Enter');
    await expect(session.locator('#switch-status')).toContainText('рекламы');
    expect((await room()).playback.revision).toBe(0);
    await b.context().setOffline(true);
    await expect(button).toBeDisabled();
    await b.locator('#movie_player').evaluate(el => el.classList.remove('ad-showing'));
    await b.context().setOffline(false);
    await expect(button).toBeEnabled();
    await b.waitForTimeout(600);
    expect((await room()).playback.revision).toBe(0);
    await expect(a).toHaveURL(watch);
    await b.evaluate(id => history.pushState({}, '', `/shorts/${id}`), next);
    await expect(button).toBeHidden();
    await expect.poll(async () => (await session.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility)).toBe('hidden');
    expect((await room()).playback.revision).toBe(0);
    await b.evaluate(id => history.pushState({}, '', `/watch?v=${id}`), next);
    await expect.poll(async () => (await session.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility)).toBe('visible');
    await session.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect(b).toHaveURL(watch);
  });
});

test('более поздняя смена побеждает задержанную; ожидание блокирует повтор, создатель может выйти', async () => {
  let armed = false;
  let release: (() => void) | undefined;
  let writes = 0;
  await withPlaybackPair(async ({ a, b, room }) => {
    armed = true;
    await propose(b, next);
    await expect.poll(() => !!release).toBe(true);
    const session = await frameOf(b);
    await expect(session.getByRole('button', { name: 'Смотреть это в комнате', exact: true })).toBeDisabled();
    await expect(session.locator('#switch-status')).toHaveText('Меняем видео…');
    expect((await room()).playback.revision).toBe(0);
    await propose(a, other, 31);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: other, revision: 1 });
    release!();
    await expect(session.locator('#switch-status')).toContainText('Смена не принята');
    expect(writes).toBe(1);
    await expect(b).toHaveURL(url(next));
    await session.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect(b).toHaveURL(url(other));
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 31 });
    await (await frameOf(a)).getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(1);
    await propose(b, next, 17);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: next, revision: 2, videoRevision: 2 });
    await expect(a).toHaveURL(url(other));
    await b.waitForTimeout(650);
    expect((await room()).playback.revision).toBe(2);
  }, async context => {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
          writes++;
          if (armed) { armed = false; release = () => server.send(message); return; }
        }
        server.send(message);
      });
    });
  });
});

for (const cut of ['before-server', 'before-ack'] as const) test(`смена: обрыв ${cut}, reload/worker restart и reconnect без replay`, async () => {
  let armed = false, disconnected = false, intercepted = false, writes = 0;
  await withPlaybackPair(async ({ a, b, room }) => {
    armed = true;
    await propose(b, next);
    await expect.poll(() => intercepted).toBe(true);
    const session = await frameOf(b);
    await expect(session.locator('[role="status"]')).toContainText('Просмотр остаётся локальным.');
    const latest = (await room()).playback;
    expect(latest.revision).toBe(cut === 'before-server' ? 0 : 1);
    const worker = await workerOf(b.context());
    await (await stopWorker(b.context(), b, worker)).detach();
    await b.reload();
    await expect.poll(() => b.frames().some(frame => frame.url().includes('/session.html#'))).toBe(true);
    disconnected = false;
    const restored = await frameOf(b);
    await expect(restored.locator('[role="status"]')).toHaveText(/Смотрим вместе|Ожидаем плеер|Локальный просмотр|Нажмите play/, { timeout: 30_000 });
    await b.waitForTimeout(700);
    await expect(b).toHaveURL(url(next));
    if (cut === 'before-ack') {
      await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 22 });
      await expect(restored.getByRole('link', { name: 'Вернуться в комнату' })).toBeHidden();
      await expect(a).toHaveURL(url(next));
    } else {
      await expect(restored.getByRole('link', { name: 'Вернуться в комнату' })).toBeVisible();
      await restored.getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
      await expect(b).toHaveURL(watch);
      await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 10 });
    }
    expect((await room()).playback).toEqual(latest);
    expect(writes).toBe(1);
  }, async context => {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      if (disconnected) { void ws.close(); return; }
      const server = ws.connectToServer();
      let request: number | undefined;
      const close = () => { disconnected = true; intercepted = true; void ws.close(); void server.close(); };
      ws.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
          writes++;
          if (armed) {
            armed = false;
            if (cut === 'before-server') { close(); return; }
            request = packet.d.r;
          }
        }
        server.send(message);
      });
      server.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (request !== undefined && packet?.d?.r === request) { expect(packet.d.b.s).toBe('ok'); close(); return; }
        ws.send(message);
      });
    });
  });
});

test('серверные смены во время загрузки: последнее поколение, отмена старого удержания без эха', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    let release!: () => void;
    let loading = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await b.route(url(next), async route => { loading = true; await gate; await route.fallback(); });
    await b.locator('#movie_player').focus();
    await b.keyboard.down('ArrowRight');
    await propose(a, next);
    await expect.poll(() => loading).toBe(true);
    await propose(a, new URL(watch).searchParams.get('v')!, 37);
    await expect.poll(async () => (await room()).playback).toMatchObject({ videoId: new URL(watch).searchParams.get('v'), revision: 2, videoRevision: 2 });
    release();
    await expect(b).toHaveURL(watch);
    await b.keyboard.up('ArrowRight');
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 37, isPlaying: false });
    await b.waitForTimeout(700);
    expect((await room()).playback.revision).toBe(2);
  });
});

test('локальный уход отменяет уже подготовленную навигацию; stale target/route не управляют вкладкой', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    const worker = await workerOf(b.context());
    await worker.evaluate(() => {
      const scope = globalThis as any;
      const original = scope.chrome.storage.session.set.bind(scope.chrome.storage.session);
      scope.chrome.storage.session.set = async (values: any) => {
        await original(values);
        if (Object.values(values['roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]'] ?? {}).some((binding: any) => binding.view?.pendingNavigation) && !scope.navigationHeld) {
          scope.navigationHeld = true;
          await new Promise<void>(resolve => { scope.releaseNavigation = resolve; });
        }
      };
    });
    await propose(a, next);
    await expect.poll(() => worker.evaluate(() => !!(globalThis as any).navigationHeld)).toBe(true);
    await b.goto(url(other));
    await worker.evaluate(() => (globalThis as any).releaseNavigation());
    const session = await frameOf(b);
    await expect(session.locator('#player-status')).toContainText('Не синхронизируется');
    await b.waitForTimeout(600);
    await expect(b).toHaveURL(url(other));
    expect((await room()).playback.revision).toBe(1);
    const result = await session.evaluate(async playback => {
      const api = (globalThis as any).chrome;
      return api.runtime.sendMessage({ type: 'room-tab-view', backendGeneration: 'emulator-v1', target: crypto.randomUUID(), route: { videoId: 'M7lc1UVf-VE', sequence: 0 },
        playback, ownCommand: false, force: true });
    }, (await room()).playback);
    expect(result?.view).toBeUndefined();
    const stale = await session.evaluate(async playback => (globalThis as any).chrome.runtime.sendMessage({
      type: 'room-tab-view', backendGeneration: 'emulator-v1', target: location.hash.slice(1), playback,
      route: { videoId: 'aqz-KE-bpKQ', sequence: 0 }, ownCommand: false, force: true,
    }), (await room()).playback);
    expect(stale).toEqual({ stale: true });
  });
});

test('быстрый локальный A → B → A между сверками восстанавливает управление без новой revision', async () => {
  await withPlaybackPair(async ({ b, room }) => {
    const session = await frameOf(b);
    const worker = await workerOf(b.context());
    const target = new URL(session.url()).hash.slice(1);
    const view = () => worker.evaluate(async target => {
      const stored = await (globalThis as any).chrome.storage.session.get('roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]');
      return Object.values(stored['roomTabBindings:roomCatalog:v2:emulator-v1:[true,"demo-watch-together","https://demo-watch-together-default-rtdb.firebaseio.com","http://127.0.0.1:5002/"]']).find((item: any) => item.target === target) as any;
    }, target);
    await session.evaluate(() => {
      const scope = globalThis as any;
      const send = scope.chrome.tabs.sendMessage.bind(scope.chrome.tabs);
      scope.chrome.tabs.sendMessage = async (...args: any[]) => {
        if (args[1]?.type === 'room-player-context' && !scope.contextHeld) {
          scope.contextHeld = true;
          await new Promise<void>(resolve => { scope.releaseContext = resolve; });
        }
        return send(...args);
      };
    });
    await expect.poll(() => session.evaluate(() => !!(globalThis as any).contextHeld)).toBe(true);
    await b.evaluate(id => history.pushState({}, '', `/watch?v=${id}`), next);
    await expect.poll(async () => (await view()).view.route.videoId).toBe(next);
    await b.evaluate(watch => history.pushState({}, '', watch), watch);
    await expect.poll(async () => (await view()).view.mode).toBe('following');
    await session.evaluate(() => (globalThis as any).releaseContext());
    await b.waitForTimeout(500);
    expect((await room()).playback.revision).toBe(0);
    await b.locator('#movie_player').focus();
    await b.keyboard.press('ArrowRight');
    await expect.poll(async () => (await room()).playback.revision).toBe(1);
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 15 });
  });
});

test('смена маршрута после snapshot отменяет явное действие до транзакции', async () => {
  await withPlaybackPair(async ({ b, room }) => {
    await b.goto(url(next));
    await readyPlayer(b);
    const session = await frameOf(b);
    await session.evaluate(() => {
      const scope = globalThis as any;
      const send = scope.chrome.tabs.sendMessage.bind(scope.chrome.tabs);
      scope.chrome.tabs.sendMessage = async (...args: any[]) => {
        const result = await send(...args);
        if (args[1]?.type === 'room-player-snapshot') {
          scope.snapshotRead = true;
          await new Promise<void>(resolve => { scope.releaseSnapshot = resolve; });
        }
        return result;
      };
    });
    await session.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
    await expect.poll(() => session.evaluate(() => !!(globalThis as any).snapshotRead)).toBe(true);
    await b.evaluate(id => history.pushState({}, '', `/watch?v=${id}`), other);
    await session.evaluate(() => (globalThis as any).releaseSnapshot());
    await expect(session.locator('#switch-status')).toContainText('Видео изменилось');
    expect((await room()).playback.revision).toBe(0);
    await expect(b).toHaveURL(url(other));
  });
});

for (const restriction of ['buffering', 'seeking', 'unavailable', 'live'] as const) test(`snapshot ${restriction} не создаёт смену`, async () => {
  await withPlaybackPair(async ({ b, room }) => {
    await b.goto(url(next));
    await readyPlayer(b);
    const session = await frameOf(b);
    await restrictSnapshot(b, restriction);
    await session.getByRole('button', { name: 'Смотреть это в комнате', exact: true }).press('Enter');
    await expect(session.locator('#switch-status')).toContainText('Дождитесь');
    await b.waitForTimeout(300);
    expect((await room()).playback.revision).toBe(0);
  });
});

test('поздняя транзакция seek из первого A не меняет комнату после A → B → A', async ({}, testInfo) => {
  let armed = false;
  let release: (() => void) | undefined;
  await withPlaybackPair(async ({ a, b, room }) => {
    armed = true;
    await b.locator('#movie_player').focus();
    await b.keyboard.press('ArrowRight');
    await expect.poll(() => !!release).toBe(true);
    // SPA-уход сохраняет документ/SDK с реально задержанной транзакцией.
    await b.evaluate(id => history.pushState({}, '', `/watch?v=${id}`), other);
    await expect((await frameOf(b)).locator('#player-status')).toContainText('Не синхронизируется');
    await propose(a, next);
    await expect.poll(async () => (await room()).playback.revision).toBe(1);
    await propose(a, new URL(watch).searchParams.get('v')!, 34);
    await expect.poll(async () => (await room()).playback.revision).toBe(2);
    const latest = (await room()).playback;
    release!();
    await b.waitForTimeout(700);
    expect((await room()).playback).toEqual(latest);
    await expect(b).toHaveURL(url(other));
    await (await frameOf(b)).getByRole('link', { name: 'Вернуться в комнату' }).press('Enter');
    await expect(b).toHaveURL(watch);
    await expect.poll(() => sample(b)).toMatchObject({ positionSeconds: 34 });
    await testInfo.attach('late-generation-result', { contentType: 'application/json', body: JSON.stringify({
      sequence: 'A → B → A', revision: latest.revision, videoRevision: latest.videoRevision,
      positionSeconds: latest.positionSeconds, lateCommandChangedServer: false, detachedStayedLocal: true,
    }) });
  }, async context => {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (armed && packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
          armed = false; release = () => server.send(message); return;
        }
        server.send(message);
      });
    });
  });
});

test('выход во время ожидания ack смены игнорирует поздний ответ и не восстанавливает привязку', async () => {
  let armed = false;
  let release: (() => void) | undefined;
  await withPlaybackPair(async ({ a, b, room }) => {
    armed = true;
    await propose(b, next);
    await expect.poll(() => !!release).toBe(true);
    const session = await frameOf(b);
    await session.getByRole('button', { name: 'Выйти из комнаты' }).press('Enter');
    await expect(session.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    release!();
    await b.waitForTimeout(700);
    await expect(session.locator('[role="status"]')).toHaveText('Вы вышли из комнаты.');
    await expect(session.getByRole('button', { name: 'Смотреть это в комнате', exact: true })).toBeHidden();
    await expect(a).toHaveURL(url(next));
    expect((await room()).playback.revision).toBe(1);
    await b.reload();
    await b.waitForTimeout(500);
    expect(b.frames().some(f => f.url().includes('/session.html#'))).toBe(false);
  }, async context => {
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:9000\//, ws => {
      const server = ws.connectToServer();
      let request: number | undefined;
      ws.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (armed && packet?.d?.a === 'p' && packet.d.b?.p?.endsWith('/playback') && 'h' in packet.d.b) {
          armed = false; request = packet.d.r;
        }
        server.send(message);
      });
      server.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (request !== undefined && packet?.d?.r === request) {
          request = undefined; expect(packet.d.b.s).toBe('ok'); release = () => ws.send(message); return;
        }
        ws.send(message);
      });
    });
  });
});
