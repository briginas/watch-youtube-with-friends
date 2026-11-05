import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createYouTubePlayerAdapter, type PlayerIntent, type PlayerStatus, type PlayerTrace } from '../../../src/lib/player/youtube-player';
import { getWatchVideoId } from '../../../src/lib/youtube-url';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const videoId = getWatchVideoId(location.href);
    if (!videoId) return;
    const intents: PlayerIntent[] = [];
    const interactions: boolean[] = [];
    const traces: PlayerTrace[] = [];
    const host = document.createElement('div');
    host.id = 'watch-together-player-probe';
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('div');
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#15202b;color:white;padding:10px;font:13px system-ui';
    label.setAttribute('role', 'status');
    label.textContent = 'Player probe: missing';
    const returnLink = document.createElement('a');
    returnLink.textContent = 'Вернуться в комнату';
    returnLink.href = `https://www.youtube.com/watch?v=${videoId}`;
    returnLink.style.cssText = 'color:#9cd5ff;margin-top:6px';
    returnLink.hidden = true;
    const messages: Partial<Record<PlayerStatus, string>> = {
      'autoplay-blocked': 'Нажмите play, чтобы продолжить',
      'unavailable': 'Видео недоступно в этой вкладке',
      'different-video': 'Не синхронизируется: открыт другой ролик',
    };
    panel.append(label, returnLink);
    shadow.append(panel);
    document.documentElement.append(host);
    const adapter = createYouTubePlayerAdapter({
      videoId,
      onIntent(intent) { intents.push(intent); if (intents.length > 100) intents.shift(); },
      onInteraction(active) { interactions.push(active); if (interactions.length > 100) interactions.shift(); },
      onStatus(status) {
        label.textContent = `Player probe: ${status}${messages[status] ? ` — ${messages[status]}` : ''}`;
        returnLink.hidden = status !== 'different-video';
      },
      onTrace(trace) { traces.push(trace); if (traces.length > 300) traces.shift(); },
    });
    // Only extension contexts can send these probe messages; no credentials here.
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message, sender) => {
      if (sender.id !== browser.runtime.id || !message || message.type !== 'player-probe') return;
      if (message.action === 'read') return Promise.resolve({ ...adapter.read(), intents, traces, interactions });
      if (message.action === 'clear') { intents.length = 0; traces.length = 0; interactions.length = 0; return Promise.resolve(true); }
      if (message.action === 'apply') return adapter.apply(message.target);
      if (message.action === 'dispose') { adapter.dispose(); return Promise.resolve(true); }
    };
    browser.runtime.onMessage.addListener(listener);
    ctx.onInvalidated(() => {
      adapter.dispose();
      browser.runtime.onMessage.removeListener(listener);
      host.remove();
    });
  },
});
