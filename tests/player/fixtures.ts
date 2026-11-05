import { resolve } from 'node:path';
import { test as base, expect, type Page, type Worker } from '@playwright/test';
import { launchExtension } from '../e2e/fixtures';
import type { PlaybackSample, PlayerIntent, PlayerStatus, PlayerTrace } from '../../src/lib/player/youtube-player';

export type ProbeReport = { status: PlayerStatus; sample: PlaybackSample | null; intents: PlayerIntent[]; traces: PlayerTrace[]; interactions: boolean[] };
export const test = base.extend<{ worker: Worker; requireActivation: boolean }>({
  requireActivation: [false, { option: true }],
  context: async ({ requireActivation }, use) => {
    const context = await launchExtension(resolve('.output/youtube-player/chrome-mv3'), requireActivation ? [
      '--autoplay-policy=document-user-activation-required',
      '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
    ] : []);
    try { await use(context); } finally { await context.close(); }
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'));
  },
});
export { expect };

export async function probe(worker: Worker, page: Page, action = 'read', target?: PlaybackSample) {
  return worker.evaluate(async ({ url, action, target }) => {
    const extension = (globalThis as unknown as { chrome: {
      tabs: { query(query: object): Promise<{ id?: number; url?: string }[]>;
        sendMessage(tabId: number, message: object): Promise<unknown> };
    } }).chrome;
    const tabs = await extension.tabs.query({});
    const tab = tabs.find(tab => tab.url === url);
    if (!tab?.id) throw new Error(`Probe tab missing: ${url}`);
    return extension.tabs.sendMessage(tab.id, { type: 'player-probe', action, target });
  }, { url: page.url(), action, target });
}
export const readProbe = async (worker: Worker, page: Page): Promise<ProbeReport> => (await probe(worker, page)) as ProbeReport;

// Playwright page/locator evaluations mark execution as userGesture=true. Inspect
// policy without granting the activation whose absence this experiment must prove.
export async function readUserActivation(page: Page): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'navigator.userActivation.hasBeenActive', returnByValue: true, userGesture: false,
    });
    return result.result.value;
  } finally { await cdp.detach(); }
}

// A real seekable media resource, generated locally: no YouTube or external fixture dependency.
function silentWav() {
  const bytes = 30 * 8000;
  const wav = Buffer.alloc(44 + bytes, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}
export async function openFixture(page: Page, worker: Worker, options: { userActivation?: boolean } = {}) {
  await page.route('https://www.youtube.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <input id="search" aria-label="Search">
      <div id="movie_player" tabindex="0">
        <video class="html5-main-video" preload="auto" src="${silentWav()}"></video>
        <button class="ytp-play-button">Play/pause</button>
        <div class="ytp-progress-bar" tabindex="0" style="width:400px;height:30px;background:#999">Seek</div>
        <button class="ytp-variable-speed-panel-button">1</button>
        <button class="ytp-volume-icon">Volume</button>
        <button id="system">System event</button>
      </div>
      <script>
      const player = document.querySelector('#movie_player');
      const video = () => player.querySelector('video');
      let playerRate = 1;
      player.getPlaybackRate = () => playerRate;
      player.setPlaybackRate = rate => {
        playerRate = rate; video().playbackRate = rate;
        player.querySelector('.ytp-variable-speed-panel-button').textContent = String(rate);
      };
      player.querySelector('.ytp-play-button').onclick = () => video().paused ? video().play() : video().pause();
      player.querySelector('.ytp-progress-bar').onpointerdown = () => { video().currentTime = 8; };
      player.querySelector('.ytp-progress-bar').onpointermove = e => { if (e.buttons) video().currentTime = 12; };
      player.querySelector('.ytp-variable-speed-panel-button').onclick = () => player.setPlaybackRate(1.5);
      player.querySelector('.ytp-volume-icon').onclick = () => { video().volume = 0.4; };
      player.querySelector('#system').onclick = () => { video().playbackRate = 1.25; };
      document.addEventListener('keydown', e => {
        if (e.target.matches('input')) return;
        if (e.key === 'k' || e.key === ' ') video().paused ? video().play() : video().pause();
        if (e.key === 'ArrowRight') video().currentTime += 5;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === '>' || (e.shiftKey && e.code === 'Period')) player.setPlaybackRate(playerRate + 0.25);
        if (e.key === '<' || (e.shiftKey && e.code === 'Comma')) player.setPlaybackRate(playerRate - 0.25);
      });
      </script></body></html>`,
  }));
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  if (options.userActivation !== false) await expect(page.locator('#watch-together-player-probe')).toBeAttached();
  await expect.poll(async () => (await readProbe(worker, page).catch(() => null))?.status).toBe('ready');
  await probe(worker, page, 'clear');
}
