import { resolve } from 'node:path';
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { launchExtension } from '../e2e/fixtures';
import type { TransportState } from '../../src/lib/room/transport';

declare const chrome: typeof browserApi;

export const watch = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const database = 'http://127.0.0.1:9000';
const namespace = 'demo-watch-together-default-rtdb';
const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

export async function admin(path: string, value: unknown) {
  const response = await fetch(`${database}/${path}.json?ns=${namespace}`, {
    method: 'PUT', headers, body: JSON.stringify(value),
  });
  expect(response.ok).toBe(true);
}

export async function workerOf(context: BrowserContext) {
  return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
}

export async function setup(realYouTube = false, body = '<!doctype html><title>Управляемый watch-стенд</title><h1>Видео</h1>', headless = process.env.TRANSPORT_HEADED !== '1', extraArgs: string[] = []) {
  const context = await launchExtension(resolve('.output/room-transport/chrome-mv3'), extraArgs, headless);
  if (!realYouTube) await context.route('https://www.youtube.com/**', (route) => route.fulfill({
    contentType: 'text/html', body,
  }));
  const worker = await workerOf(context);
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

// Chrome action popup не представлен Playwright Page. CDP исполняет код
// непосредственно в настоящем POPUP, не добавляя API в продуктовую сборку.
export async function popup(context: BrowserContext, page: Page, extensionId: string, backendGeneration = 'emulator-v1') {
  // Управляющий extension-документ работает и при остановленном worker.
  const cdp = await context.browser()!.newBrowserCDPSession();
  const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(item => item.targetId));
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(driver.locator('[role="status"]')).toHaveText('Откройте обычное видео на YouTube.');
  await page.bringToFront();
  await driver.evaluate(() => chrome.action.openPopup());
  await driver.close();
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => !before.has(item.targetId) && item.url === `chrome-extension://${extensionId}/popup.html`)!;
  expect(target).toBeTruthy();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId });
  let sequence = 0;
  async function protocol<T>(method: string, params = {}): Promise<T> {
    const id = ++sequence;
    const response = new Promise<T>((resolveValue, reject) => {
      const timeout = setTimeout(() => {
        cdp.off('Target.receivedMessageFromTarget', listener);
        reject(new Error(`Popup CDP timeout: ${method}`));
      }, 5_000);
      const listener = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const result = JSON.parse(event.message);
        if (result.id !== id) return;
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', listener);
        if (result.error) reject(new Error(`Popup CDP error: ${method}`));
        else resolveValue(result.result as T);
      };
      cdp.on('Target.receivedMessageFromTarget', listener);
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId, message: JSON.stringify({ id, method, params }),
    });
    return response;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const result = await protocol<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text);
    return result.result.value;
  }
  let rejectedAuthRequests = 0;
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === 'Fetch.requestPaused') {
      rejectedAuthRequests++;
      void protocol('Fetch.fulfillRequest', authRejection(message.params.requestId));
    }
  });
  return {
    evaluate, protocol,
    rejectedAuthRequests: () => rejectedAuthRequests,
    async request(target: string, action = 'status', extra = {}) {
      const state = await evaluate<TransportState>(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'room-session', backendGeneration, target, action, ...extra })})`);
      if (action === 'create' && state.invitation) {
        const frame = context.pages().flatMap(page => page.frames()).find(frame => frame.url().endsWith(`/session.html#${target}`));
        if (frame) {
          await expect.poll(async () => (await frame.frameElement()).evaluate(el => getComputedStyle(el as Element).visibility)).toBe('visible');
          await openDetails(frame);
        }
      }
      return state;
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
      await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some((item) => item.targetId === target.targetId)).toBe(false);
      await cdp.detach();
    },
  };
}

export async function frameOf(page: Page, expand = true) {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('/session.html#'))).toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/session.html#'))!;
  await expect(frame.locator('#status')).not.toHaveText('Подключаемся…');
  if (expand) await openDetails(frame);
  return frame;
}

// Старые сценарии проверяют действия подробностей. Новые UI-проверки
// вызывают frameOf(page, false), чтобы наблюдать исходное свёрнутое состояние.
export async function openDetails(frame: import('@playwright/test').Frame) {
  const iframe = await frame.frameElement();
  if (await iframe.evaluate(el => getComputedStyle(el as Element).visibility) !== 'visible') return;
  const toggle = frame.locator('#room-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.press('Enter');
  if (await toggle.isVisible()) await settlePanel(frame);
}

export async function panelBounds(frame: import('@playwright/test').Frame) {
  const iframe = await frame.frameElement();
  return iframe.evaluate(el => (el.getRootNode() as ShadowRoot).host.getBoundingClientRect().toJSON() as DOMRect);
}

export async function settlePanel(frame: import('@playwright/test').Frame) {
  await expect.poll(async () => {
    const outer = await panelBounds(frame);
    const inner = await frame.locator('#room-panel').boundingBox();
    return !!inner && Math.abs(outer.height - inner.height) < 2 && Math.abs(outer.bottom - inner.y - inner.height) < 1;
  }).toBe(true);
}

export async function sessionPlayback(frame: import('@playwright/test').Frame) {
  const page = frame.page();
  const target = new URL(frame.url()).hash.slice(1);
  const driver = await page.context().newPage();
  try {
    await driver.goto(new URL('/popup.html', frame.url()).href);
    const state = await driver.evaluate(async target =>
      chrome.runtime.sendMessage({ type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'status' }), target);
    return state?.room?.playback;
  } finally { await driver.close(); await page.bringToFront(); }
}

export async function stopWorker(context: BrowserContext, page: Page, worker: Worker) {
  const cdp = await context.newCDPSession(page);
  let versionId: string | undefined;
  let runningStatus: string | undefined;
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const match = versions.find((item: { scriptURL: string; status: string }) => item.scriptURL === worker.url() && item.status === 'activated');
    if (match) { versionId = match.versionId; runningStatus = match.runningStatus; }
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versionId).toBeTruthy();
  await cdp.send('ServiceWorker.stopWorker', { versionId: versionId! });
  await expect.poll(() => runningStatus).toBe('stopped');
  return cdp;
}

function authRejection(requestId: string) {
  return {
    requestId, responseCode: 400,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify({ error: { message: 'OPERATION_NOT_ALLOWED' } })).toString('base64'),
  };
}

