import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchExtension } from '../e2e/fixtures';
import { installPopupFixture } from './popup-fixture';
import english from '../../public/_locales/en/messages.json' with { type: 'json' };
import russian from '../../public/_locales/ru/messages.json' with { type: 'json' };
import type { browser as browserApi } from 'wxt/browser';

declare const chrome: typeof browserApi;

for (const locale of ['ru', 'ru-RU', 'en', 'de']) {
  test(`язык браузера ${locale}: popup, панель и приглашение`, async () => {
    const context = await launchExtension(resolve('.output/release/chrome-mv3'), [], true, '', locale);
    try {
      // Native Chrome i18n остаётся настоящим; только комнатные данные popup — fixture.
      await context.route('https://**/*', route => route.abort());
      await installPopupFixture(context);
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const native = await worker.evaluate(() => ({ language: chrome.i18n.getUILanguage(),
        manifest: chrome.runtime.getManifest(), participant: chrome.i18n.getMessage('participant', ['2', '']) }));
      expect(native.language.split('-')[0]).toBe(locale.split('-')[0]);
      const lang = locale.startsWith('ru') ? 'ru' : 'en';
      const messages = lang === 'ru' ? russian : english;
      expect(native.manifest.description).toBe(messages.extensionDescription.message);
      expect(native.participant).toBe(lang === 'ru' ? 'Участник 2' : 'Participant 2');
      const origin = `chrome-extension://${new URL(worker.url()).host}`;
      const errors: string[] = [];
      const popup = await context.newPage();
      popup.on('pageerror', error => errors.push(error.message));
      await popup.setViewportSize({ width: 336, height: 600 });
      await popup.goto(`${origin}/popup.html`);
      await expect(popup.locator('html')).toHaveAttribute('lang', lang);
      await expect(popup.getByRole('heading', { name: messages.watchTogether.message, exact: true })).toBeVisible();
      await expect(popup.getByRole('button', { name: messages.copyInvitation.message })).toBeEnabled();
      await popup.locator('summary').click();
      await expect(popup.getByRole('list', { name: messages.participants.message })).toContainText(lang === 'ru' ? 'Участник 1 (вы)' : 'Participant 1 (you)');
      await expect(popup.getByText('Музыка для вечера', { exact: true })).toBeVisible();
      await expect(popup.getByRole('switch', { name: messages.darkTheme.message })).toHaveAttribute('title', messages.useDarkTheme.message);
      expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(336);
      // Ошибка storage проверяет динамический перевод, а не только статические кнопки.
      await popup.evaluate(() => { chrome.storage.local.set = async () => { throw new Error('fixture'); }; });
      await popup.getByRole('switch').click();
      await expect(popup.getByRole('status').filter({ hasText: messages.saveThemeFailed.message })).toBeVisible();

      const session = await context.newPage();
      session.on('pageerror', error => errors.push(error.message));
      await session.addInitScript(() => {
        chrome.runtime.sendMessage = (async (message: { type: string }) => {
          if (message.type === 'room-tab-ready') return { binding: { key: 'a'.repeat(64), name: 'Исходное название комнаты' } };
          if (message.type === 'room-tab-catalog-status') return { catalogError: null };
          return { accepted: true };
        }) as typeof chrome.runtime.sendMessage;
      });
      await session.setViewportSize({ width: 336, height: 600 });
      await session.goto(`${origin}/session.html#${crypto.randomUUID()}`);
      await expect(session.locator('html')).toHaveAttribute('lang', lang);
      await expect(session).toHaveTitle(messages.sessionTitle.message);
      await expect(session.locator('#room-name')).toHaveText('Исходное название комнаты');
      await expect(session.locator('#copy-invitation')).toHaveAttribute('aria-label', messages.copyInvitation.message);
      // Все внешние запросы прерваны: настоящая клиентская ошибка и таймер повтора.
      await expect(session.locator('#connection-status')).toContainText(lang === 'ru' ? 'Следующая попытка через' : 'Next attempt in');
      await expect(session.locator('#notice-close')).toHaveAttribute('title', messages.closeMessage.message);
      await session.locator('#room-toggle').click();
      await expect(session.getByRole('button', { name: messages.leaveRoom.message, exact: true })).toBeVisible();
      // Перевод label сохраняет вложенное поле ручного копирования.
      await expect(session.locator('#manual-invitation input')).toHaveCount(1);
      expect(await session.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(336);

      const controlOrigin = native.manifest.host_permissions!.find((url: string) => !url.includes('youtube.com'))!.replace(/\/\*$/, '');
      await context.route(`${controlOrigin}/**`, route => route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><main><div id="installation">Install</div><div id="extension-join"></div></main>' }));
      const invitation = await context.newPage();
      invitation.on('pageerror', error => errors.push(error.message));
      await invitation.goto(`${controlOrigin}/#room=invalid`);
      await expect.poll(() => invitation.frames().some(frame => frame.url().includes('/invitation.html#'))).toBe(true);
      const frame = invitation.frames().find(frame => frame.url().includes('/invitation.html#'))!;
      await expect(frame.locator('html')).toHaveAttribute('lang', lang);
      await expect(frame.locator('#status')).toHaveText(messages.invalidInvitation.message);
      expect(await frame.title()).toBe(messages.joinRoomTitle.message);
      await expect(invitation.locator('#installation')).toBeHidden();
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
