import { expect, test, type Frame, type Page } from '@playwright/test';
import { frameOf, panelBounds as bounds, settlePanel } from './fixtures';
import { withPlaybackPair } from './playback-fixture';
import type { browser as browserApi } from 'wxt/browser';
declare const chrome: typeof browserApi;

async function visibility(frame: Frame) {
  return (await frame.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility);
}

async function enterFullscreen(page: Page, selector: string) {
  await page.bringToFront();
  await page.locator(selector).evaluate(el => el.requestFullscreen());
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
}

async function startDrag(page: Page, frame: Frame) {
  await page.bringToFront();
  await settlePanel(frame);
  const header = (await frame.locator('#room-toggle').boundingBox())!;
  const point = { x: header.x + 30, y: header.y + 20 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}

async function dragBy(page: Page, frame: Frame, dx: number, dy: number) {
  const point = await startDrag(page, frame);
  await moveMouse(page, point, { x: point.x + dx, y: point.y + dy });
  await page.mouse.up();
}

async function moveMouse(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = Math.max(12, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 8));
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
    // Даём compositor применить новую геометрию OOPIF перед следующим вводом.
    await page.waitForTimeout(25);
  }
}

test.describe('мышь в видимом Chromium', () => {
test.skip(process.env.TRANSPORT_HEADED !== '1', 'Нужен TRANSPORT_HEADED=1: headless Chromium направляет мышь в host вместо extension iframe.');

test('drag свёрнутой/раскрытой панели сохраняет клик, клавиатуру и playback', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const before = (await room()).playback;
    await frame.locator('#room-toggle').press('Enter');
    await settlePanel(frame);
    let initial = await bounds(frame);
    await a.locator('#movie_player').focus();
    await dragBy(a, frame, 220, -180);
    await expect.poll(async () => (await bounds(frame)).x).toBeCloseTo(initial.x + 220, 0);
    await expect.poll(async () => (await bounds(frame)).y).toBeCloseTo(initial.y - 180, 0);
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'false');
    await frame.locator('#room-toggle').click();
    await expect(frame.locator('#room-details')).toBeVisible();
    await settlePanel(frame);
    initial = await bounds(frame);
    await dragBy(a, frame, 100, -80);
    await expect.poll(async () => (await bounds(frame)).x).toBeCloseTo(initial.x + 100, 0);
    await expect.poll(async () => (await bounds(frame)).y).toBeCloseTo(initial.y - 80, 0);
    await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'true');
    const moved = await bounds(frame);
    await enterFullscreen(a, 'html');
    await a.evaluate(() => document.exitFullscreen());
    await expect.poll(() => visibility(frame)).toBe('visible');
    expect(await bounds(frame)).toEqual(moved);
    await frame.locator('#room-toggle').press('Escape');
    await expect(frame.locator('#room-toggle')).toBeFocused();
    await expect(frame.locator('#room-details')).toBeHidden();
    await frame.locator('#room-toggle').press('Space');
    await expect(frame.locator('#room-details')).toBeVisible();
    expect((await room()).playback).toEqual(before);
  });
});

test('drag: края окна, resize, раскрытие, SPA и сброс положения после reload', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const before = (await room()).playback;
    await frame.locator('#room-toggle').press('Enter');
    await dragBy(a, frame, 400, -200);
    const moved = await bounds(frame);
    await a.evaluate(() => {
      history.pushState(null, '', '/watch?v=dQw4w9WgXcQ');
      document.dispatchEvent(new Event('yt-navigate-finish'));
    });
    await expect(frame.locator('#status')).toContainText('Локальный просмотр');
    await settlePanel(frame);
    const detached = await bounds(frame);
    expect(detached.x).toBe(moved.x);
    expect(detached.y + detached.height).toBeCloseTo(moved.y + moved.height, 0);
    await a.setViewportSize({ width: 640, height: 480 });
    await settlePanel(frame);
    for (const point of [{ x: 0, y: 0 }, { x: 640, y: 480 }]) {
      const start = await startDrag(a, frame);
      await moveMouse(a, start, point);
      await a.mouse.up();
      await expect.poll(async () => {
        const box = await bounds(frame);
        return point.x === 0 ? [box.x, box.y] : [box.x + box.width, box.y + box.height];
      }).toEqual(point.x === 0 ? [12, 12] : [628, 468]);
    }
    await frame.locator('#room-toggle').press('Enter');
    await settlePanel(frame);
    const box = await bounds(frame);
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.y).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(628);
    expect(box.y + box.height).toBeLessThanOrEqual(468);
    await frame.locator('#leave').scrollIntoViewIfNeeded();
    await expect(frame.locator('#leave')).toBeInViewport();
    await a.reload();
    const restored = await frameOf(a, false);
    await expect.poll(() => visibility(restored)).toBe('visible');
    await settlePanel(restored);
    const reset = await bounds(restored);
    expect(reset.x).toBe(12);
    expect(reset.y + reset.height).toBe(468);
    expect((await room()).playback).toEqual(before);
  });
});

test('отмена drag, потеря захвата/фокуса и fullscreen завершают жест без зависания', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const before = (await room()).playback;
    await frame.locator('#room-toggle').press('Enter');
    for (const reason of ['cancel', 'capture', 'blur', 'fullscreen']) {
      const point = await startDrag(a, frame);
      await moveMouse(a, point, { x: point.x + 50, y: point.y - 30 });
      await expect(frame.locator('#room-toggle')).toHaveClass('dragging');
      if (reason === 'fullscreen') {
        await enterFullscreen(a, 'html');
      } else if (reason === 'blur') {
        // Потеря фокуса iframe: переводим фокус в другую вкладку браузера.
        const other = await a.context().newPage();
        await other.bringToFront();
        await expect(frame.locator('#room-toggle')).not.toHaveClass('dragging');
        await other.close();
        await a.bringToFront();
      } else {
        await frame.locator('#room-toggle').evaluate((el, reason) => {
          if (reason === 'cancel') el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
          else el.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true }));
        }, reason);
      }
      await expect(frame.locator('#room-toggle')).not.toHaveClass('dragging');
      if (reason === 'fullscreen') await a.evaluate(() => document.exitFullscreen());
      await expect.poll(() => visibility(frame)).toBe('visible');
      const stopped = await bounds(frame);
      await a.mouse.move(point.x + 100, point.y - 60, { steps: 5 });
      await a.mouse.up();
      expect(await bounds(frame)).toEqual(stopped);
      await frame.locator('#room-toggle').click();
      await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'true');
      await frame.locator('#room-toggle').press('Escape');
      await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', 'false');
    }
    expect((await room()).playback).toEqual(before);
  });
});

test('геометрия отклоняет сообщения страницы, чужого iframe, неверного target и прежнего жеста', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const target = new URL(frame.url()).hash.slice(1);
    const before = (await room()).playback;
    await frame.locator('#room-toggle').press('Enter');
    await dragBy(a, frame, 150, -100); // Жест 1 завершён.
    const moved = await bounds(frame);
    const start = { type: 'room-panel-drag', target, gesture: 2, sequence: 0, phase: 'start', dx: 0, dy: 0 };
    const move = { ...start, sequence: 1, phase: 'move', dx: 300, dy: -100 };
    await a.evaluate(async ({ start, move }) => {
      window.postMessage(start, '*'); window.postMessage(move, '*');
      window.dispatchEvent(new MessageEvent('message', { source: window.frames[0],
        origin: 'chrome-extension://fake', data: start }));
      const other = document.createElement('iframe');
      other.srcdoc = `<script>parent.postMessage(${JSON.stringify(start)}, '*'); parent.postMessage(${JSON.stringify(move)}, '*');</script>`;
      await new Promise<void>(resolve => { other.onload = () => resolve(); document.body.append(other); });
      other.remove();
    }, { start, move });
    await frame.evaluate(({ start, move }) => {
      for (const message of [start, move]) {
        parent.postMessage({ ...message, target: '1fa35482-0b9b-467a-a287-b605ba99ef55' }, '*');
        parent.postMessage({ ...message, gesture: 1 }, '*');
        parent.postMessage({ ...message, gesture: 3, dx: Infinity }, '*');
      }
    }, { start, move });
    await a.waitForTimeout(200);
    expect(await bounds(frame)).toEqual(moved);
    expect((await room()).playback).toEqual(before);
  });
});

});

test('док сохраняет положение при раскрытии и сворачивании, включая нехватку места сверху', async () => {
  await withPlaybackPair(async ({ a }) => {
    await a.setViewportSize({ width: 640, height: 480 });
    const frame = await frameOf(a);
    const toggle = frame.locator('#room-toggle');
    const dock = frame.locator('#room-dock');
    await expect(frame.locator('#status')).toHaveText('Смотрим вместе');

    async function setExpanded(expanded: boolean) {
      const offsets = await dock.evaluate(async element => {
        const bottom = () => element.getBoundingClientRect().bottom - innerHeight;
        const initial = bottom();
        element.querySelector<HTMLButtonElement>('#room-toggle')!.click();
        const offsets = [bottom() - initial];
        for (let frame = 0; frame < 4; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          offsets.push(bottom() - initial);
        }
        return offsets;
      });
      for (const offset of offsets) expect(offset).toBeCloseTo(0, 0);
      await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
      await settlePanel(frame);
    }

    // Сообщения идут из настоящего session iframe. Координаты задаём напрямую,
    // чтобы проверка раскрытия не зависела от pointer capture Chromium.
    async function moveDock(gesture: number, dx: number, dy: number) {
      await frame.evaluate(({ gesture, dx, dy }) => {
        const target = location.hash.slice(1);
        for (const [sequence, phase] of ['start', 'move', 'end'].entries()) {
          parent.postMessage({ type: 'room-panel-drag', target, gesture, sequence, phase, dx, dy }, 'https://www.youtube.com');
        }
      }, { gesture, dx, dy });
    }

    async function expectDockAt(expected: NonNullable<Awaited<ReturnType<typeof dock.boundingBox>>>) {
      const actual = (await dock.boundingBox())!;
      expect(actual.x).toBe(expected.x);
      expect(actual.y).toBeCloseTo(expected.y, 0);
      expect(actual.width).toBe(expected.width);
      expect(actual.height).toBe(expected.height);
    }

    const expandedHeight = (await bounds(frame)).height;
    await toggle.press('Escape');
    await settlePanel(frame);
    const initial = await bounds(frame);
    // Оставляем 20 px запаса над реальной высотой подробностей.
    // Нехватку места сверху проверяем отдельным движением ниже.
    const dy = -Math.min(60, Math.max(0, initial.y + initial.height - expandedHeight - 12 - 20));
    await moveDock(1, 1000, dy);
    await expect.poll(async () => {
      const box = await bounds(frame);
      return [box.x + box.width, box.y];
    }).toEqual([628, initial.y + dy]);
    const right = (await dock.boundingBox())!;
    await setExpanded(true);
    await expectDockAt(right);
    await setExpanded(false);
    await expectDockAt(right);

    await moveDock(2, 0, -1000);
    await expect.poll(async () => (await bounds(frame)).y).toBe(12);
    const top = (await dock.boundingBox())!;
    await setExpanded(true);
    const shifted = (await dock.boundingBox())!;
    expect((await bounds(frame)).y).toBe(12);
    expect(shifted.x).toBe(top.x);
    expect(shifted.y).toBeGreaterThan(top.y);
    await setExpanded(false);
    await expectDockAt(shifted);
  });
});

test('fullscreen плеера/root скрывает панель без изменения сессии и восстанавливает раскрытие', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const title = await a.title();
    const before = await room();
    for (const expanded of [false, true]) {
      if (await frame.locator('#room-toggle').getAttribute('aria-expanded') !== String(expanded)) {
        await frame.locator('#room-toggle').press('Enter');
      }
      await settlePanel(frame);
      for (const selector of ['#movie_player', 'html']) {
        await enterFullscreen(a, selector);
        await expect.poll(() => visibility(frame)).toBe('hidden');
        expect(await a.title()).toBe(title);
        const during = await room();
        expect(during.playback).toEqual(before.playback);
        expect(Object.keys(during.presence ?? {})).toEqual(Object.keys(before.presence ?? {}));
        await a.evaluate(() => document.exitFullscreen());
        await expect.poll(() => visibility(frame)).toBe('visible');
        await expect(frame.locator('#room-toggle')).toHaveAttribute('aria-expanded', String(expanded));
      }
    }
    // Состояние YouTube без fullscreen-элемента тоже скрывает панель.
    await a.locator('#movie_player').evaluate(el => el.classList.add('ytp-fullscreen'));
    await expect.poll(() => visibility(frame)).toBe('hidden');
    await a.locator('#movie_player').evaluate(el => el.classList.remove('ytp-fullscreen'));
    await expect.poll(() => visibility(frame)).toBe('visible');
    expect((await room()).playback).toEqual(before.playback);
  });
});

test('выход через popup во время fullscreen не восстанавливает панель завершённой сессии', async () => {
  await withPlaybackPair(async ({ a, room }) => {
    const frame = await frameOf(a);
    const before = (await room()).playback;
    const extensionId = new URL(frame.url()).hostname;
    // Постоянный popup-документ: настоящий action popup закрывается при переходе
    // в fullscreen в headed Chrome. Канал и проверка sender остаются продуктовыми.
    const control = await a.context().newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    const target = new URL(frame.url()).hash.slice(1);
    await enterFullscreen(a, 'html');
    await expect.poll(() => visibility(frame)).toBe('hidden');
    await control.evaluate(target => chrome.runtime.sendMessage({ type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'unwatch' }), target);
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(1);
    await a.evaluate(() => document.exitFullscreen());
    await expect.poll(() => a.title()).not.toContain('Fixture | ');
    await expect.poll(() => visibility(frame)).toBe('hidden');
    expect((await room()).playback).toEqual(before);
    await control.close();
  });
});
