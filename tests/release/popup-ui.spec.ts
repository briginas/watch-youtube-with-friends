import { installPopupFixture } from './popup-fixture';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { launchExtension } from '../e2e/fixtures';
import type { browser as browserApi } from 'wxt/browser';

declare const chrome: typeof browserApi;

const themeKey = 'watch-together:popup-theme:v1';
let context: BrowserContext;
let url: string;

test.beforeEach(async () => {
  context = await launchExtension(resolve('.output/release/chrome-mv3'));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  url = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
  // UI-стенд: реальные React/CSS и storage расширения, комнатный transport подменён.
  // Никакие комнаты или обращения к production Firebase не создаются.
  await context.route('https://**/*', route => route.abort());
  await installPopupFixture(context);
});

test.afterEach(async () => { await context?.close(); });

async function open() {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Копировать приглашение' })).toBeEnabled();
  return page;
}

const themeSwitch = (page: Page) => page.getByRole('switch', { name: 'Тёмная тема' });
async function savedTheme(page: Page) {
  return page.evaluate(async key => (await chrome.storage.local.get(key))[key], themeKey);
}

test('светлая тема по умолчанию, клавиатура, сохранение и повторное открытие без сброса UI', async () => {
  const page = await open();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  const details = page.locator('details');
  await details.locator('summary').click();
  await themeSwitch(page).focus();
  await themeSwitch(page).press('Space');
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(details).toHaveAttribute('open', '');
  expect(await themeSwitch(page).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  await expect.poll(() => savedTheme(page)).toBe('dark');
  const reopened = await open();
  await expect(themeSwitch(reopened)).toHaveAttribute('aria-checked', 'true');
  await themeSwitch(reopened).click();
  await expect.poll(() => savedTheme(reopened)).toBe('light');
  await reopened.reload();
  await expect(themeSwitch(reopened)).toHaveAttribute('aria-checked', 'false');
  const commands = await page.evaluate(() => (globalThis as unknown as { popupFixture: { commands: string[] } }).popupFixture.commands);
  expect(commands.every(command => ['room-session/status', 'room-catalog/list'].includes(command))).toBe(true);
});

test('неизвестная тема, отказы чтения и сохранения не блокируют popup', async () => {
  const page = await open();
  await page.evaluate(async key => { await chrome.storage.local.set({ [key]: 'unknown' }); }, themeKey);
  await page.reload();
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => { chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); }; });
  await themeSwitch(page).click();
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Не удалось сохранить тему.', { exact: false })).toBeVisible();
  await themeSwitch(page).click();
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await context.addInitScript(() => { chrome.storage.local.get = async () => { throw new Error('Storage unavailable'); }; });
  await page.reload();
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('button', { name: 'Копировать приглашение' })).toBeEnabled();
});

test('скроллбары окна и каталога следуют теме и сохраняют прокрутку', async () => {
  await context.addInitScript(() => {
    if (location.pathname !== '/popup.html') return;
    const sendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (async (message: { type: string }) => {
      if (message.type === 'room-catalog') return {
        entries: Array.from({ length: 8 }, (_, i) => ({ key: `room-${i}`, name: `Комната ${i + 1}` })),
        tabStates: {},
      };
      return sendMessage(message);
    }) as typeof chrome.runtime.sendMessage;
  });
  const page = await open();
  const catalog = page.getByRole('region', { name: 'Мои комнаты' }).getByRole('list');
  await expect(catalog.getByRole('listitem')).toHaveCount(8);
  const palettes = {
    light: 'rgb(123, 97, 90) rgb(255, 243, 232)',
    dark: 'rgb(212, 180, 205) rgb(48, 32, 44)',
  };
  for (const width of [400, 336]) {
    await page.setViewportSize({ width, height: 600 });
    for (const theme of ['light', 'dark', 'light'] as const) {
      if (await themeSwitch(page).getAttribute('aria-checked') !== String(theme === 'dark')) {
        await themeSwitch(page).click();
      }
      for (const area of [page.locator('html'), catalog]) {
        await expect(area).toHaveCSS('scrollbar-color', palettes[theme]);
        await expect(area).toHaveCSS('scrollbar-width', 'thin');
        const overflow = await area.evaluate(element => ({
          vertical: element.scrollHeight > element.clientHeight,
          horizontal: element.scrollWidth > element.clientWidth,
        }));
        expect(overflow).toEqual({ vertical: true, horizontal: false });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(10, 300);
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => page.evaluate(() => window.scrollY + innerHeight >= document.documentElement.scrollHeight)).toBe(true);
      await catalog.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => catalog.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight)).toBe(true);
      await expect(catalog.getByText('Комната 8', { exact: true })).toBeInViewport();
      await catalog.evaluate(element => { element.scrollTop = 0; });
    }
  }
});

test('две палитры сохраняют геометрию, контраст и доступность длинных названий', async () => {
  const page = await open();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const bounds = () => page.locator('main').boundingBox();
  const lightBounds = await bounds();
  await mkdir('.output/popup-preview', { recursive: true });
  await page.screenshot({ path: '.output/popup-preview/light.png', fullPage: true });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await themeSwitch(page).click();
    expect(await bounds()).toEqual(lightBounds);
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(['page', 'surface', 'text', 'muted', 'error', 'accent', 'accent-text'].map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
    });
    const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((total, channel, i) => total + channel * [.2126, .7152, .0722][i]!, 0);
    const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    for (const foreground of ['text', 'muted', 'error']) for (const background of ['page', 'surface']) {
      expect(contrast(colors[foreground]!, colors[background]!), `${theme}: ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(colors['accent-text']!, colors.accent!)).toBeGreaterThanOrEqual(4.5);
  }
  await page.screenshot({ path: '.output/popup-preview/dark.png', fullPage: true });
  await page.evaluate(() => {
    (globalThis as unknown as { popupFixture: { state: { roomName: string } } }).popupFixture.state.roomName = 'Очень длинное название '.repeat(12);
  });
  await expect(page.locator('strong')).toContainText('Очень длинное название');
  for (const width of [400, 336]) {
    await page.setViewportSize({ width, height: 600 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const element of await page.getByRole('button').all()) {
      const box = (await element.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  }
  expect(errors).toEqual([]);
});
