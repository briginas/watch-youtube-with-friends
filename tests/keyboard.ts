import type { Page } from '@playwright/test';

/** Trusted input with the key/code pair emitted by the Russian keyboard layout.
 * This emulates the event, without changing the host's active input source. */
export async function russianRateShortcut(page: Page, direction: 'up' | 'down') {
  const cdp = await page.context().newCDPSession(page);
  const key = direction === 'up' ? 'Ю' : 'Б';
  const code = direction === 'up' ? 'Period' : 'Comma';
  const windowsVirtualKeyCode = direction === 'up' ? 190 : 188;
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: 8 });
  } finally { await cdp.detach(); }
}
