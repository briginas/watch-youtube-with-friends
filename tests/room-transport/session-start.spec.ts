import { test, expect } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';
import { frameOf, popup, setup, watch } from './fixtures';
import { playerFixture, readyPlayer } from './playback-fixture';

declare const chrome: typeof browserApi;

test('первое подключение: SPA с главной и поиска, новая вкладка, прямой вход и повторный popup', async ({}, testInfo) => {
  const { context, extensionId, worker } = await setup(false, playerFixture());
  try {
    // Только адреса для диагностики Chrome; Auth и данные комнаты не записываем.
    await worker.evaluate(() => {
      const messages: { type: string; url?: string; tabUrl?: string }[] = [];
      Object.assign(globalThis, { sessionStartMessages: messages });
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (['room-tab-restore', 'room-tab-attach'].includes(message?.type)) {
          messages.push({ type: message.type, url: sender.url, tabUrl: sender.tab?.url });
        }
      });
    });
    const messages = () => worker.evaluate(() =>
      (globalThis as unknown as { sessionStartMessages: { type: string; url?: string; tabUrl?: string }[] }).sessionStartMessages);
    const initialUrls = ['https://www.youtube.com/', 'https://www.youtube.com/results?search_query=video', watch];
    for (const [index, initialUrl] of initialUrls.entries()) {
      const page = await context.newPage();
      await page.goto(initialUrl);
      await readyPlayer(page);
      await expect.poll(async () => (await messages()).filter(m => m.type === 'room-tab-restore').length).toBe(index + 1);
      if (initialUrl !== watch) {
        const unsupported = await popup(context, page, extensionId);
        await expect.poll(() => unsupported.evaluate<string>('document.body.textContent'))
          .toContain('Откройте обычное видео на YouTube.');
        expect(page.frames().filter(f => f.url().includes('/session.html#'))).toHaveLength(0);
        await unsupported.close();
        // Content script уже запущен в исходном документе, навигация не делает reload.
        await page.evaluate(url => history.pushState({}, '', url), watch);
      }
      let control = await popup(context, page, extensionId);
      await expect.poll(() => control.evaluate<string>('document.body.textContent'))
        .toContain('Подключено. Комната ещё не выбрана.');
      const disabled = () => control.evaluate<boolean>('[...document.querySelectorAll("button")].find(b => b.textContent === "Смотреть вместе").disabled');
      expect(await disabled()).toBe(false);
      const sessionUrl = (await frameOf(page)).url();
      await control.close();
      control = await popup(context, page, extensionId);
      await expect.poll(disabled).toBe(false);
      expect(page.frames().filter(f => f.url().includes('/session.html#')).map(f => f.url())).toEqual([sessionUrl]);
      await control.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Смотреть вместе").click(); true');
      await expect.poll(() => control.evaluate<string>('document.body.textContent')).toContain('Комната подключена.');
      await control.close();
    }
    const observed = await messages();
    expect(observed.filter(m => m.type === 'room-tab-attach')).toEqual(initialUrls.map(url => ({
      type: 'room-tab-attach', url, tabUrl: watch,
    })));
    await testInfo.attach('sender-urls', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });
  } finally { await context.close(); }
});
