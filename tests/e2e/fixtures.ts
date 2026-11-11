import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test as base, chromium, type BrowserContext } from '@playwright/test';

export async function launchExtension(extensionPath = resolve('.output/chrome-mv3'), extraArgs: string[] = [], headless = true, userDataDir = '', uiLocale = 'ru') {
  // На macOS --lang не меняет UI locale: задаём AppleLanguages только процессу
  // временного браузера. Системные preferences и пользовательский Chrome не меняются.
  const launcherDir = process.platform === 'darwin' ? mkdtempSync(`${tmpdir()}/watch-together-browser-`) : undefined;
  const launcher = launcherDir && `${launcherDir}/chrome.sh`;
  if (launcher) writeFileSync(launcher, '#!/bin/sh\nexec "$WATCH_TOGETHER_TEST_BROWSER" -AppleLanguages "($WATCH_TOGETHER_TEST_LOCALE)" "$@"\n', { mode: 0o700 });
  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless,
      locale: uiLocale,
      ...(launcher ? {
        executablePath: launcher,
        env: { ...process.env, WATCH_TOGETHER_TEST_BROWSER: chromium.executablePath(), WATCH_TOGETHER_TEST_LOCALE: uiLocale },
        // Значение AppleLanguages также воспринимается Chromium как начальная вкладка.
        ignoreDefaultArgs: ['about:blank'],
      } : {}),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--lang=${uiLocale}`,
        ...extraArgs,
      ],
    });
    context.on('close', () => { if (launcherDir) rmSync(launcherDir, { recursive: true, force: true }); });
    return context;
  } catch (error) {
    if (launcherDir) rmSync(launcherDir, { recursive: true, force: true });
    throw error;
  }
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await launchExtension();
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

export { expect } from '@playwright/test';
