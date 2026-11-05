import { test, expect, openFixture, probe, readProbe } from './fixtures';
import { russianRateShortcut } from '../keyboard';

for (const layout of ['English', 'Russian']) test(`${layout}: клавиши скорости после remote apply дают по одному намерению`, async ({ page, worker }) => {
  await openFixture(page, worker);
  expect(await probe(worker, page, 'apply', { positionSeconds: 4, playbackRate: 1.25, isPlaying: false })).toBe('applied');
  await page.locator('#movie_player').focus();
  for (const direction of ['up', 'down'] as const) {
    if (layout === 'Russian') await russianRateShortcut(page, direction);
    else await page.keyboard.press(direction === 'up' ? 'Shift+Period' : 'Shift+Comma');
    await expect.poll(async () => (await readProbe(worker, page)).sample?.playbackRate).toBe(direction === 'up' ? 1.5 : 1.25);
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(intent => ({ kind: intent.kind, rate: intent.sample.playbackRate })))
      .toEqual(direction === 'up' ? [{ kind: 'rate', rate: 1.5 }] : [{ kind: 'rate', rate: 1.5 }, { kind: 'rate', rate: 1.25 }]);
  }
  await page.waitForTimeout(250);
  expect((await readProbe(worker, page)).intents).toHaveLength(2);
});

test('физические клавиши скорости без Shift, с modifiers и в текстовых полях не разрешают команды', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('#movie_player').focus();
  await page.keyboard.press('Period');
  await page.keyboard.press('Comma');
  await page.keyboard.press('Control+Shift+Period');
  await page.keyboard.press('Alt+Shift+Comma');
  await page.keyboard.press('Meta+Shift+Period');
  const search = page.getByRole('textbox', { name: 'Search' });
  await search.focus();
  await russianRateShortcut(page, 'up');
  await page.locator('#movie_player').evaluate(player => player.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Ю', code: 'Period', shiftKey: true, bubbles: true,
  })));
  // A subsequent system ratechange must not inherit permission from any input above.
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 1.5; });
  await page.waitForTimeout(250);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  expect((await readProbe(worker, page)).traces.filter(trace => trace.event === 'input')).toEqual([]);
});

test('удалённая скорость согласует media и плеер; первое > меняет скорость без эха', async ({ page, worker }) => {
  await openFixture(page, worker);
  // Reproduce the same stale internal rate even when media already matches.
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 1.25; });
  expect(await probe(worker, page, 'apply', { positionSeconds: 4, playbackRate: 1.25, isPlaying: false })).toBe('applied');
  await expect(page.locator('.ytp-variable-speed-panel-button')).toHaveText('1.25');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.locator('#movie_player').focus();
  await page.keyboard.press('Shift+Period');
  await expect.poll(async () => (await readProbe(worker, page)).intents).toEqual([
    expect.objectContaining({ kind: 'rate', sample: { positionSeconds: 4, playbackRate: 1.5, isPlaying: false } }),
  ]);
  await page.waitForTimeout(250);
  expect((await readProbe(worker, page)).intents).toHaveLength(1);
});

test('отсутствующий, сломанный или игнорирующий setter не считается успешным apply', async ({ page, worker }) => {
  await openFixture(page, worker);
  for (const mode of ['missing', 'throws', 'ignores']) {
    await page.locator('#movie_player').evaluate((root, mode) => {
      const player = root as HTMLElement & { setPlaybackRate?: () => void };
      player.setPlaybackRate = mode === 'missing' ? undefined : () => { if (mode === 'throws') throw new Error('Unavailable API'); };
    }, mode);
    expect(await probe(worker, page, 'apply', { positionSeconds: 7, playbackRate: 1.25, isPlaying: true })).toBe('blocked');
    expect((await readProbe(worker, page)).sample).toMatchObject({ positionSeconds: 0, playbackRate: 1, isPlaying: false });
  }
  expect((await readProbe(worker, page)).intents).toEqual([]);
});

test('MAIN bridge отклоняет неверный payload, другой videoId и посторонний media element', async ({ page, worker }) => {
  await openFixture(page, worker);
  const results = await page.evaluate(() => {
    const video = document.querySelector('video')!;
    const other = video.cloneNode() as HTMLVideoElement;
    document.body.append(other);
    const send = (target: Element, payload: unknown) => target.dispatchEvent(new CustomEvent('watch-together:set-player-rate', {
      detail: JSON.stringify(payload), bubbles: true, cancelable: true,
    }));
    const valid = { videoId: 'aqz-KE-bpKQ', playbackRate: 1.5 };
    return [send(video, { ...valid, playbackRate: 0 }), send(video, { ...valid, videoId: 'dQw4w9WgXcQ' }),
      send(video, { ...valid, arbitraryMethod: 'playVideo' }), send(other, valid)];
  });
  expect(results).toEqual([true, true, true, true]);
  expect((await readProbe(worker, page)).sample?.playbackRate).toBe(1);
  expect((await readProbe(worker, page)).intents).toEqual([]);
});

test('кнопки, клавиатура и seek drag дают пользовательские намерения', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play']);
  await page.locator('#movie_player').focus();
  await page.keyboard.press('k');
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play', 'pause']);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.kind).toBe('seek');
  await page.locator('.ytp-variable-speed-panel-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.sample.playbackRate).toBe(1.5);
  await page.locator('#movie_player').focus();
  await page.keyboard.press('>');
  await expect.poll(async () => (await readProbe(worker, page)).intents.at(-1)?.sample.playbackRate).toBe(1.75);
  await probe(worker, page, 'clear');
  const bar = await page.locator('.ytp-progress-bar').boundingBox();
  if (!bar) throw new Error('Seek bar missing');
  await page.mouse.move(bar.x + 10, bar.y + 10);
  await page.mouse.down();
  await page.mouse.move(bar.x + 200, bar.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await readProbe(worker, page)).intents).toEqual([
    expect.objectContaining({ kind: 'seek', sample: { positionSeconds: 12, playbackRate: 1.75, isPlaying: false } }),
  ]);
});

test('programmatic media events, чужие кнопки и ввод текста не создают команд', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.evaluate(async () => {
    const v = document.querySelector('video')!;
    v.playbackRate = 1.25; v.currentTime = 3; await v.play(); v.pause();
  });
  await page.locator('#system').click();
  await page.locator('.ytp-volume-icon').click();
  await page.getByRole('textbox', { name: 'Search' }).fill('k j l >');
  await page.getByRole('textbox', { name: 'Search' }).press('k');
  await page.evaluate(() => document.querySelector('.ytp-play-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(250);
  const report = await readProbe(worker, page);
  expect(report.intents).toEqual([]);
  expect(report.traces.some(t => t.event === 'play' && t.trusted)).toBe(true);
});

test('клавиши личных контролов не превращают системные media events в общие команды', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('#movie_player').evaluate(root => {
    root.insertAdjacentHTML('beforeend', '<div class="ytp-volume-panel" tabindex="0">Volume</div><button class="ytp-subtitles-button">Captions</button><div class="ytp-settings-menu"><div class="ytp-panel-menu"><button role="menuitemradio"><span class="ytp-menuitem-label">360p</span></button></div></div>');
  });
  await page.locator('.ytp-volume-panel').press('ArrowLeft');
  // Перестройка медиа после личной настройки не подтверждает общий seek.
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 4; });
  await page.waitForTimeout(250);
  await page.locator('.ytp-subtitles-button').press('Space');
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.locator('.ytp-settings-menu button').press('Space');
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.waitForTimeout(250);
  const report = await readProbe(worker, page);
  expect(report.intents).toEqual([]);
  expect(report.traces.filter(t => t.event === 'input')).toEqual([]);
  // Числовое меню скорости внутри того же settings popup остаётся общим.
  await page.locator('.ytp-panel-menu').evaluate(menu => {
    menu.innerHTML = ['0.5', '1', '1.5'].map(rate => `<button role="menuitemradio"><span class="ytp-menuitem-label">${rate}</span></button>`).join('');
    for (const button of menu.querySelectorAll('button')) button.onclick = () => {
      document.querySelector('video')!.playbackRate = Number(button.textContent);
    };
  });
  await page.getByRole('menuitemradio', { name: '1.5', exact: true }).click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['rate']);
});

test('remote apply не прерывает drag; отпускание подтверждает новую позицию без эха', async ({ page, worker }) => {
  await openFixture(page, worker);
  const bar = await page.locator('.ytp-progress-bar').boundingBox();
  if (!bar) throw new Error('Seek bar missing');
  await page.mouse.move(bar.x + 10, bar.y + 10);
  await page.mouse.down();
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  const target = { positionSeconds: 4, playbackRate: 1.5, isPlaying: true };
  expect(await probe(worker, page, 'apply', target)).toBe('interrupted');
  await page.waitForTimeout(200);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  const releasedAt = await page.evaluate(() => Date.now());
  await page.mouse.up();
  await expect.poll(async () => (await readProbe(worker, page)).intents).toHaveLength(1);
  const confirmed = (await readProbe(worker, page)).intents[0]!;
  expect(confirmed).toMatchObject({ kind: 'seek', sample: { positionSeconds: 8, isPlaying: false, playbackRate: 1 } });
  expect(confirmed.actionAt).toBeGreaterThanOrEqual(releasedAt);
  expect(confirmed.sampledAt - confirmed.actionAt).toBeGreaterThanOrEqual(100);
  await probe(worker, page, 'clear');
  expect(await probe(worker, page, 'apply', { ...target, isPlaying: false })).toBe('applied');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play']);
});

test('удержание seek-клавиши с паузой автоповтора отправляет итог только после keyup', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('#movie_player').focus();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400); // initial OS auto-repeat delay exceeds debounce
  expect((await readProbe(worker, page)).intents).toEqual([]);
  expect(await probe(worker, page, 'apply', { positionSeconds: 2, playbackRate: 1, isPlaying: false })).toBe('interrupted');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(200);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  const releasedAt = await page.evaluate(() => Date.now());
  await page.keyboard.up('ArrowRight');
  await expect.poll(async () => (await readProbe(worker, page)).intents).toHaveLength(1);
  const confirmed = (await readProbe(worker, page)).intents[0]!;
  expect(confirmed).toMatchObject({ kind: 'seek', sample: { positionSeconds: 15, playbackRate: 1, isPlaying: false } });
  expect(confirmed.actionAt).toBeGreaterThanOrEqual(releasedAt);
  expect(confirmed.sampledAt - confirmed.actionAt).toBeGreaterThanOrEqual(100);
});

test('серия коротких seek-нажатий объединяется; blur отменяет незавершённое удержание', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('#movie_player').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await readProbe(worker, page)).intents).toHaveLength(1);
  expect((await readProbe(worker, page)).intents[0]).toMatchObject({ kind: 'seek', sample: { positionSeconds: 15 } });
  await probe(worker, page, 'clear');
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(200);
  const cancelled = await readProbe(worker, page);
  expect(cancelled.intents).toEqual([]);
  expect(cancelled.interactions.at(-1)).toBe(false);
  expect(await probe(worker, page, 'apply', { positionSeconds: 2, playbackRate: 1, isPlaying: false })).toBe('applied');
});

test('ad и buffering остаются локальными, после восстановления управление работает', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.evaluate(() => {
    document.querySelector('#movie_player')!.classList.add('ad-showing');
    const v = document.querySelector('video')!;
    v.currentTime = 1; v.playbackRate = 2;
  });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ad');
  await page.locator('.ytp-play-button').click();
  expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate: 1, isPlaying: false })).toBe('blocked');
  await expect.poll(async () => (await readProbe(worker, page)).traces.some(t => t.event === 'playing')).toBe(true);
  await page.evaluate(() => document.querySelector('video')!.pause());
  await expect.poll(async () => (await readProbe(worker, page)).traces.some(t => t.event === 'pause')).toBe(true);
  await page.evaluate(() => document.querySelector('#movie_player')!.classList.remove('ad-showing'));
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('waiting')));
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('buffering');
  await page.locator('.ytp-variable-speed-panel-button').click();
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('canplay')));
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents).toHaveLength(1);
});

test('новое действие пользователя прерывает ожидающее применение комнаты', async ({ page, worker }) => {
  await openFixture(page, worker);
  const applying = probe(worker, page, 'apply', { positionSeconds: 0, playbackRate: 1, isPlaying: true });
  await expect.poll(async () => (await readProbe(worker, page)).sample?.isPlaying).toBe(true);
  await page.locator('.ytp-play-button').click();
  expect(await applying).toBe('interrupted');
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['pause']);
});

test('замена video/root и dispose очищают старые обработчики и незавершённое применение', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.evaluate(() => {
    const old = document.querySelector('video')!;
    const replacement = old.cloneNode() as HTMLVideoElement;
    old.replaceWith(replacement);
    document.body.append(old); old.id = 'old-video';
  });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['play']);
  await probe(worker, page, 'clear');
  await page.evaluate(async () => { const old = document.querySelector<HTMLVideoElement>('#old-video')!; await old.play(); old.pause(); });
  expect((await readProbe(worker, page)).traces).toEqual([]);
  // Replacement while apply is pending must resolve rather than act on the new element.
  const applying = probe(worker, page, 'apply', { positionSeconds: 7, playbackRate: 1.25, isPlaying: false });
  await expect.poll(async () => (await readProbe(worker, page)).traces.some(t => t.event === 'apply' && t.detail === 'started')).toBe(true);
  await page.evaluate(() => { const old = document.querySelector('#movie_player')!; old.replaceWith(old.cloneNode(true)); });
  expect(await applying).toBe('replaced');
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await probe(worker, page, 'clear');
  await probe(worker, page, 'dispose');
  await page.evaluate(async () => { const v = document.querySelector('video')!; await v.play(); v.pause(); });
  await page.waitForTimeout(200);
  expect((await readProbe(worker, page)).traces).toEqual([]);
});

test('ошибка media и ошибка YouTube без video показываются локально', async ({ page, worker }) => {
  await openFixture(page, worker);
  const source = await page.locator('video').getAttribute('src');
  await page.locator('video').evaluate(element => { const v = element as HTMLVideoElement; v.src = 'data:video/mp4;base64,AAAA'; v.load(); });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('unavailable');
  await expect(page.getByRole('status')).toContainText('Видео недоступно');
  expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate: 1, isPlaying: true })).toBe('blocked');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.evaluate(() => {
    document.querySelector('#movie_player')!.classList.add('ytp-error');
    document.querySelector('video')!.remove();
  });
  await expect.poll(async () => (await readProbe(worker, page)).sample).toBeNull();
  expect((await readProbe(worker, page)).status).toBe('unavailable');
  await page.evaluate(src => {
    const player = document.querySelector('#movie_player')!;
    player.classList.remove('ytp-error');
    const video = document.createElement('video');
    video.className = 'html5-main-video'; video.src = src!; video.preload = 'auto';
    player.prepend(video);
  }, source);
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  expect((await readProbe(worker, page)).intents).toEqual([]);
});

test('видимый экран ошибки вне плеера блокирует команды, скрытый шаблон не мешает', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.evaluate(() => {
    const watch = document.createElement('ytd-watch-flexy');
    watch.innerHTML = '<yt-playability-error-supported-renderers hidden>Video unavailable</yt-playability-error-supported-renderers><ytd-background-promo-renderer>This video is not available</ytd-background-promo-renderer>';
    watch.hidden = true;
    document.body.append(watch);
  });
  expect((await readProbe(worker, page)).status).toBe('ready');
  await page.evaluate(() => { document.querySelector<HTMLElement>('ytd-watch-flexy')!.hidden = false; });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('unavailable');
  await expect(page.getByRole('status')).toContainText('Видео недоступно');
  expect(await probe(worker, page, 'apply', { positionSeconds: 1, playbackRate: 1, isPlaying: true })).toBe('blocked');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.evaluate(() => document.querySelector('ytd-watch-flexy')!.remove());
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
});

test('видимая ошибка внутри плеера без MediaError и ytp-error распознаётся до loading', async ({ page, worker }) => {
  await openFixture(page, worker);
  await page.locator('#movie_player').evaluate(root => {
    root.insertAdjacentHTML('beforeend', '<div class="ytp-error-content-wrap" hidden>Something went wrong</div>');
  });
  expect((await readProbe(worker, page)).status).toBe('ready');
  await page.locator('.ytp-error-content-wrap').evaluate((panel: HTMLElement) => { panel.hidden = false; });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('unavailable');
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ error: video.error, errorClass: video.closest('.ytp-error') !== null })))
    .toEqual({ error: null, errorClass: false });
  expect(await probe(worker, page, 'apply', { positionSeconds: 5, playbackRate: 1, isPlaying: true })).toBe('blocked');
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.locator('.ytp-error-content-wrap').evaluate((panel: HTMLElement) => { panel.hidden = true; });
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
});

test('SPA с прежним video блокирует применение и scrub; возврат восстанавливает привязку', async ({ page, worker }) => {
  await openFixture(page, worker);
  const bar = await page.locator('.ytp-progress-bar').boundingBox();
  if (!bar) throw new Error('Seek bar missing');
  await page.mouse.move(bar.x + 10, bar.y + 10);
  await page.mouse.down();
  await page.evaluate(() => history.pushState({}, '', '/watch?v=dQw4w9WgXcQ'));
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('different-video');
  await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('Не синхронизируется');
  await expect(page.getByRole('link', { name: 'Вернуться в комнату' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.locator('.ytp-play-button').click();
  await page.locator('.ytp-variable-speed-panel-button').click();
  const before = (await readProbe(worker, page)).sample;
  expect(await probe(worker, page, 'apply', { positionSeconds: 3, playbackRate: 1, isPlaying: false })).toBe('blocked');
  expect((await readProbe(worker, page)).sample?.playbackRate).toBe(before?.playbackRate);
  await page.goBack();
  await expect.poll(async () => (await readProbe(worker, page)).status).toBe('ready');
  await expect(page.getByRole('link', { name: 'Вернуться в комнату' })).toBeHidden();
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.locator('.ytp-play-button').click();
  await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind)).toEqual(['pause']);
});

test('SPA завершает ожидающее применение до таймаута, даже без замены DOM', async ({ page, worker }) => {
  await openFixture(page, worker);
  const applying = probe(worker, page, 'apply', { positionSeconds: 7, playbackRate: 1.25, isPlaying: false });
  await expect.poll(async () => (await readProbe(worker, page)).traces.some(t => t.event === 'apply' && t.detail === 'started')).toBe(true);
  await page.evaluate(() => history.pushState({}, '', '/watch?v=dQw4w9WgXcQ'));
  expect(await applying).toBe('blocked');
  expect((await readProbe(worker, page)).intents).toEqual([]);
});
