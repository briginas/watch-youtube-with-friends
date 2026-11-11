import { backendGeneration } from '../lib/firebase/config';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { isPopupSender, playerSnapshotRequestSchema } from '../lib/room/messages';
import { getWatchVideoId } from '../lib/youtube-url';
import { createYouTubePlayerAdapter } from '../lib/player/youtube-player';
import { isPlayerControlSender, playerControlSchema, playerContextRequestSchema } from '../lib/player/messages';
import { createRoomMetadata } from '../lib/room/metadata';
import { presentationGate, presentationSchema, type Presentation } from '../lib/room/presentation';
import { createPageTitle } from '../lib/room/page-title';
import { panelDragSchema } from '../lib/room/panel-position';

export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://youtube.com/*'],
  main(ctx) {
    let host: HTMLElement | undefined;
    let sessionFrame: HTMLIFrameElement | undefined;
    let position: { x: number; bottom: number } | undefined;
    let drag: { gesture: number; sequence: number; x: number; bottom: number } | undefined;
    let lastGesture = 0;
    const extensionOrigin = `chrome-extension://${browser.runtime.id}`;
    let target: string | undefined;
    let mounting = false;
    let adapter: ReturnType<typeof createYouTubePlayerAdapter> | undefined;
    let adapterVideoId: string | undefined;
    let adapterToken: string | undefined;
    let routeSequence = 0;
    let routeVideoId = getWatchVideoId(location.href);
    let reportedSequence = -1;
    const pageTitle = createPageTitle(document);
    let presentation: Presentation | undefined;
    let acceptPresentation = presentationGate();
    let fullscreen = false;
    function isFullscreen() {
      return !!document.fullscreenElement || !!document.querySelector('#movie_player.ytp-fullscreen, ytd-watch-flexy[fullscreen]');
    }
    function checkFullscreen() {
      const next = isFullscreen();
      if (next !== fullscreen) { fullscreen = next; renderPresentation(); }
    }
    function renderPresentation() {
      if (!host) return;
      const visible = !!presentation?.visible && !!getWatchVideoId(location.href);
      fullscreen = isFullscreen();
      host.style.visibility = visible && !fullscreen ? 'visible' : 'hidden';
      host.style.width = `${Math.max(1, Math.min(presentation?.width ?? 380, innerWidth - 24))}px`;
      host.style.height = `${Math.max(1, Math.min(presentation?.height ?? 80, innerHeight - 24))}px`;
      if (position) place(position.x, position.bottom);
      if (!visible || fullscreen) cancelDrag();
      pageTitle.set(visible ? presentation?.name ?? null : null);
    }
    function place(x: number, bottom: number) {
      if (!host) return;
      const bounds = host.getBoundingClientRect();
      const margin = 12;
      position = {
        x: Math.max(margin, Math.min(x, innerWidth - bounds.width - margin)),
        bottom: Math.max(margin + bounds.height, Math.min(bottom, innerHeight - margin)),
      };
      host.style.left = `${position.x}px`;
      host.style.bottom = `${innerHeight - position.bottom}px`;
    }
    function cancelDrag() {
      drag = undefined;
      // Отмена нужна и до достижения порога начала drag.
      sessionFrame?.contentWindow?.postMessage({ type: 'room-panel-cancel', target }, extensionOrigin);
    }
    function movePanel(event: MessageEvent) {
      if (!event.isTrusted || event.source !== sessionFrame?.contentWindow || event.origin !== extensionOrigin
        || !host?.isConnected || host.style.visibility !== 'visible' || isFullscreen()) return;
      const parsed = panelDragSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.target !== target) return;
      const message = parsed.data;
      if (message.phase === 'start') {
        if (message.gesture <= lastGesture) return;
        lastGesture = message.gesture;
        const bounds = host.getBoundingClientRect();
        drag = { gesture: message.gesture, sequence: message.sequence, x: bounds.x, bottom: bounds.bottom };
      } else if (drag?.gesture === message.gesture && message.sequence > drag.sequence) {
        drag.sequence = message.sequence;
        if (message.phase === 'move') place(drag.x + message.dx, drag.bottom + message.dy);
        else drag = undefined;
      }
    }
    async function reportRoute() {
      if (ctx.isInvalid) return { videoId: routeVideoId, sequence: routeSequence };
      const videoId = getWatchVideoId(location.href);
      if (videoId !== routeVideoId) { routeVideoId = videoId; routeSequence++; stopPlayer(); renderPresentation(); }
      if (target && host?.isConnected && reportedSequence !== routeSequence) {
        const sequence = routeSequence;
        const result = await browser.runtime.sendMessage({ type: 'room-tab-route', backendGeneration, target, route: { videoId, sequence } });
        if (result?.accepted) reportedSequence = sequence;
      }
      return { videoId: routeVideoId, sequence: routeSequence };
    }
    function stopPlayer() {
      adapter?.dispose();
      adapter = undefined;
      adapterVideoId = undefined;
      adapterToken = undefined;
    }
    function ensureSession() {
      if (ctx.isInvalid || mounting || host?.isConnected || !getWatchVideoId(location.href)) return;
      mounting = true;
      target = crypto.randomUUID();
      presentation = undefined;
      acceptPresentation = presentationGate();
      drag = undefined; lastGesture = 0;
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;bottom:12px;left:12px;width:380px;height:80px;overflow:clip;visibility:hidden;z-index:2147483647';
      const shadow = host.attachShadow({ mode: 'closed' });
      const frame = document.createElement('iframe');
      sessionFrame = frame;
      frame.src = `${browser.runtime.getURL('/session.html')}#${target}`;
      frame.title = 'Состояние совместного просмотра';
      frame.allow = 'clipboard-write';
      // Меняется область обрезки, а iframe и док остаются у её нижнего края.
      frame.style.cssText = 'position:absolute;bottom:0;left:0;width:100%;height:max(1px, calc(100vh - 24px));border:0;color-scheme:normal';
      shadow.append(frame);
      const container = host;
      void browser.runtime.sendMessage({ type: 'room-tab-attach', backendGeneration, target }).then(response => {
        if (response?.accepted && !ctx.isInvalid) document.documentElement.append(container);
      }).catch(() => {}).finally(() => { mounting = false; });
    }
    // Ответ содержит только boolean; секрет получает сам extension-документ.
    void browser.runtime.sendMessage({ type: 'room-tab-restore', backendGeneration }).then(response => {
      if (response?.restore && !ctx.isInvalid) ensureSession();
    }).catch(() => {});
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message, sender, sendResponse) => {
      if (ctx.isInvalid) return;
      const ui = presentationSchema.safeParse(message);
      if (ui.success && target && host?.isConnected && ui.data.target === target
        && isPlayerControlSender(sender, browser.runtime.id, target)) {
        if (acceptPresentation(ui.data)) { presentation = ui.data; renderPresentation(); }
        sendResponse();
        return;
      }
      if (target && host?.isConnected && isPlayerControlSender(sender, browser.runtime.id, target)
        && playerContextRequestSchema.safeParse(message).success && message.target === target) {
        void reportRoute().then(sendResponse, () => sendResponse({ error: 'Не удалось проверить вкладку.' }));
        return true;
      }
      const control = playerControlSchema.safeParse(message);
      if (control.success && control.data.target === target && host?.isConnected
        && isPlayerControlSender(sender, browser.runtime.id, target)) {
        if (control.data.type === 'room-player-stop') {
          if (adapterToken === control.data.adapterToken) stopPlayer();
          sendResponse({ stopped: true });
          return;
        }
        const { playback } = control.data;
        if (adapterVideoId !== playback.videoId || adapterToken !== control.data.adapterToken) {
          stopPlayer();
          adapterVideoId = playback.videoId;
          adapterToken = control.data.adapterToken;
          const address = { adapterToken: control.data.adapterToken, videoRevision: control.data.videoRevision };
          const emit = (event: Record<string, unknown>) => {
            if (!ctx.isInvalid && adapterToken === address.adapterToken) void browser.runtime.sendMessage({ ...event, target, ...address }).catch(() => {});
          };
          adapter = createYouTubePlayerAdapter({
            videoId: playback.videoId,
            onIntent(intent) {
              emit({ type: 'room-player-intent', videoId: playback.videoId, intent });
            },
            onInteraction(active) {
              emit({ type: 'room-player-interaction', active });
            },
            onStatus(status, localSeek) {
              emit({ type: 'room-player-status', status, localSeek });
            },
          });
        }
        void adapter!.apply(playback).then(sendResponse);
        return true;
      }
      const fromPopup = isPopupSender(sender, browser.runtime.id);
      const fromSession = !!target && isPlayerControlSender(sender, browser.runtime.id, target);
      if (!fromPopup && !fromSession) return;
      if (message?.type === 'room-player-snapshot') {
        const request = playerSnapshotRequestSchema.safeParse(message);
        if (!request.success || request.data.target !== target || !host?.isConnected) return;
        const videoId = getWatchVideoId(location.href);
        if (!videoId) { sendResponse({ error: 'Откройте обычное видео на YouTube.' }); return; }
        // Краткое чтение через проверенный адаптер, без исходящих команд.
        const adapter = createYouTubePlayerAdapter({ videoId, onIntent() {} });
        try {
          const { status, sample } = adapter.read();
          const seeking = document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video')?.seeking;
          if (status !== 'ready' || !sample || seeking) {
            sendResponse({ error: status === 'ad'
              ? 'Дождитесь окончания рекламы и повторите попытку.'
              : 'Дождитесь готовности обычного записанного видео и повторите попытку.' });
          } else {
            if (videoId !== routeVideoId) { routeVideoId = videoId; routeSequence++; stopPlayer(); }
            sendResponse({ playback: { videoId, ...sample }, sampledAt: Date.now(),
              route: { videoId, sequence: routeSequence }, metadata: createRoomMetadata() });
          }
        } finally { adapter.dispose(); }
        return;
      }
      if (!fromPopup || message?.type !== 'room-session-ensure') return;
      if (!getWatchVideoId(location.href)) {
        sendResponse({ error: 'Откройте обычное видео на YouTube.' });
        return;
      }
      ensureSession();
      // Только адрес документа. UID и room data сюда не возвращаются.
      sendResponse({ target });
    };
    browser.runtime.onMessage.addListener(listener);
    const routeTimer = ctx.setInterval(() => { checkFullscreen(); void reportRoute().catch(() => {}); }, 100);
    addEventListener('resize', renderPresentation);
    addEventListener('message', movePanel);
    document.addEventListener('fullscreenchange', checkFullscreen);
    ctx.onInvalidated(() => {
      clearInterval(routeTimer);
      stopPlayer();
      removeEventListener('resize', renderPresentation);
      removeEventListener('message', movePanel);
      document.removeEventListener('fullscreenchange', checkFullscreen);
      pageTitle.dispose();
      host?.remove();
      try { browser.runtime.onMessage.removeListener(listener); } catch { /* runtime уже выгрузил контекст */ }
    });
  },
});
