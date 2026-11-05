import { resolve } from 'node:path';
import { test as base, chromium, type BrowserContext } from '@playwright/test';

export function launchExtension(extensionPath = resolve('.output/chrome-mv3'), extraArgs: string[] = [], headless = true, userDataDir = '') {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...extraArgs,
    ],
  });
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
