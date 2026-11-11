import type { BrowserContext } from '@playwright/test';
import type { browser as browserApi } from 'wxt/browser';

declare const chrome: typeof browserApi;

export async function installPopupFixture(context: BrowserContext) {
  await context.addInitScript(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    if (location.pathname !== '/popup.html') return;
    const state = {
      phase: 'ready', connected: true, roomReady: true, roomName: '🎬 4812',
      room: 'ui-fixture', roomInvitation: 'https://example.invalid/#fixture',
      participants: [{ number: 1, color: '#a05a79', isSelf: true }, { number: 2, color: '#7454a1', isSelf: false }],
    };
    const fixture = { state, commands: [] as string[] };
    (globalThis as unknown as { popupFixture: typeof fixture }).popupFixture = fixture;
    chrome.tabs.query = (async () => [{ id: 123, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }]) as unknown as typeof chrome.tabs.query;
    chrome.tabs.sendMessage = (async () => ({ target: 'popup-ui-fixture' })) as typeof chrome.tabs.sendMessage;
    chrome.runtime.sendMessage = (async (message: { type: string; action: string }) => {
      fixture.commands.push(`${message.type}/${message.action}`);
      if (message.type === 'room-session') return fixture.state;
      if (message.type === 'room-catalog') return {
        entries: [{ key: 'current', name: '🎬 4812' }, { key: 'saved', name: 'Музыка для вечера' }],
        tabStates: { current: 'current' },
      };
      throw new Error('Unexpected UI fixture request');
    }) as typeof chrome.runtime.sendMessage;
  });
}
