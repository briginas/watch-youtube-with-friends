import { backendGeneration } from '../lib/firebase/config';
import { browser } from 'wxt/browser';
import { createRoomTransport } from '../lib/room/transport';
import { isPopupSender, sessionRequestSchema, type PopupSessionState } from '../lib/room/messages';
import './style.css';
import { pageState, playerMessages } from '../lib/room/page-state';
import { invitationUrl } from '../lib/room/creation';
import type { TransportState } from '../lib/room/transport';
import { renderParticipants } from '../lib/room/presence-ui';
import { invitationKey, invitationRoomSchema } from '../lib/room/invitation';
import { firebaseConfig } from '../lib/firebase/config';
import { createSyncEngine } from '../lib/playback/engine';
import { applyResultSchema, isPlayerEventSender, playerEventSchema } from '../lib/player/messages';
import { initialPlaybackSchema } from '../lib/playback/model';
import { createVideoSwitchCommand } from '../lib/playback/commands';
import { routeSchema, viewSchema } from '../lib/room/view';
import type { PlayerStatus } from '../lib/player/youtube-player';
import { bindPanelDrag } from './panel-drag';
import { generationBlocksEntry } from '../lib/connection-error';

// Только публичный адрес получателя. Auth и секрет комнаты в URL не попадают.
const target = location.hash.slice(1);
const status = document.querySelector<HTMLElement>('#status')!;
const syncedStatus = document.querySelector<HTMLParagraphElement>('#synced-status')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const stopRecovery = document.querySelector<HTMLButtonElement>('#stop-recovery')!;
const participants = document.querySelector<HTMLElement>('#participants')!;
const leave = document.querySelector<HTMLButtonElement>('#leave')!;
const playerStatus = document.querySelector<HTMLParagraphElement>('#player-status')!;
const returnVideo = document.querySelector<HTMLAnchorElement>('#return-video')!;
const catalogStatus = document.querySelector<HTMLParagraphElement>('#catalog-status')!;
const switchVideo = document.querySelector<HTMLButtonElement>('#switch-video')!;
const switchStatus = document.querySelector<HTMLParagraphElement>('#switch-status')!;
const catalogRetry = document.querySelector<HTMLButtonElement>('#catalog-retry')!;
function showCatalogError(error: string | null) {
  catalogStatus.textContent = error ? `Комната открыта, но не сохранена. ${error}` : '';
  catalogStatus.hidden = !error;
  catalogRetry.hidden = !error;
  catalogError = error;
  render();
}
async function updateCatalogStatus(retry = false) {
  const response = await browser.runtime.sendMessage({ type: retry ? 'room-tab-catalog-retry' : 'room-tab-catalog-status', backendGeneration, target });
  if (response && 'catalogError' in response) showCatalogError(response.catalogError);
}
function showPlayerStatus(localStatus?: PlayerStatus) {
  localPlayerStatus = localStatus;
  playerStatus.textContent = localStatus && localStatus !== 'buffering' ? playerMessages[localStatus] ?? '' : '';
  playerStatus.hidden = !playerStatus.textContent;
  returnVideo.hidden = localStatus !== 'different-video' && localStatus !== 'unavailable';
  returnVideo.textContent = localStatus === 'unavailable' ? 'Перезагрузить видео' : 'Вернуться в комнату';
  render();
}
let left = false;
let tabId: number | undefined;
let syncError: string | null = null;
let bindingReady = false;
let following = false;
let changing = false;
let reconciling = false;
let forceReturn = false;
let currentGeneration = -1;
let currentRouteSequence = -1;
let adapterToken = crypto.randomUUID();
let appliedToken = adapterToken;
let lastReconciled = '';
let closed = false;
let localPlayerStatus: PlayerStatus | undefined;
let lastState: TransportState | undefined;
let catalogError: string | null = null;
let actionError: string | null = null;
let switchError: string | null = null;
let viewError: string | null = null;
let roomName: string | null = null;
let roomInvitation: string | null = null;
let expanded = false;
let leaving = false;
let renderFrame = 0;
let copying = false;
let copyFeedbackTimer = 0;
let presentationSequence = 0;
let lastPresentation: string | undefined;
const panel = document.querySelector<HTMLElement>('#room-panel')!;
const toggle = document.querySelector<HTMLButtonElement>('#room-toggle')!;
const roomLabel = document.querySelector<HTMLElement>('#room-name')!;
const participantNumber = document.querySelector<HTMLElement>('#participant-number')!;
const problem = document.querySelector<HTMLElement>('#problem')!;
const disposeDrag = bindPanelDrag(toggle, target);
const details = document.querySelector<HTMLElement>('#room-details')!;
const copy = document.querySelector<HTMLButtonElement>('#copy-invitation')!;
const manual = document.querySelector<HTMLElement>('#manual-invitation')!;
const invitationLink = document.querySelector<HTMLInputElement>('#invitation-link')!;
const copyStatus = document.querySelector<HTMLElement>('#copy-status')!;
function configureRoom(key: string, name: string) {
  roomName = name;
  const config = firebaseConfig();
  const invitation = config ? invitationUrl(config.invitationBaseUrl, key) : null;
  if (roomInvitation !== invitation) {
    clearTimeout(copyFeedbackTimer);
    copyStatus.textContent = '';
    manual.hidden = true;
    invitationLink.value = '';
  }
  roomInvitation = invitation;
  render();
}
function present() {
  if (closed || tabId === undefined) return;
  const content = {
    visible: bindingReady && !left, name: roomName, width: 256,
    height: Math.max(1, Math.min(4096, Math.ceil(panel.getBoundingClientRect().height))),
  };
  const signature = JSON.stringify(content);
  if (signature === lastPresentation) return;
  lastPresentation = signature;
  const sequence = ++presentationSequence;
  void browser.tabs.sendMessage(tabId, {
    type: 'room-presentation', target, sequence,
    ...content,
  }, { frameId: 0 }).catch(() => { if (sequence === presentationSequence) lastPresentation = undefined; });
}
function measure() {
  clearTimeout(renderFrame);
  renderFrame = window.setTimeout(present, 0);
}
function render() {
  if (closed) return;
  if (lastState) {
    const state = pageState(lastState, { following, player: localPlayerStatus, left,
      problem: !!(syncError || catalogError || actionError || switchError || viewError) });
    status.textContent = state.text;
    syncedStatus.hidden = !(state.synced || state.buffering) || state.problem;
    toggle.title = state.text;
    participantNumber.textContent = String(state.count ?? '—');
    panel.toggleAttribute('data-synced', state.synced);
    panel.toggleAttribute('data-buffering', state.buffering);
    panel.toggleAttribute('data-problem', state.problem);
    problem.hidden = !state.problem;
    const announcement = [state.text, state.problem ? 'Требуется внимание.' : '',
      actionError, viewError, switchError, catalogError, copyStatus.textContent].filter(Boolean).join(' ');
    const live = document.querySelector('#announcement')!;
    if (live.textContent !== announcement) live.textContent = announcement;
  }
  roomLabel.textContent = roomName ?? 'Комната';
  roomLabel.title = roomName ?? '';
  document.querySelector('#full-room-name')!.textContent = roomName;
  document.querySelector('#action-status')!.textContent = actionError ?? viewError ?? syncError ?? '';
  toggle.setAttribute('aria-expanded', String(expanded));
  details.hidden = !expanded;
  leave.hidden = !bindingReady || left;
  leave.disabled = leaving;
  copy.disabled = !roomInvitation || left;
  measure();
}
function setExpanded(next: boolean) { expanded = next; render(); }
toggle.addEventListener('click', () => setExpanded(!expanded));
addEventListener('keydown', event => {
  if (event.key === 'Escape' && expanded) {
    event.preventDefault(); setExpanded(false); toggle.focus();
  }
  event.stopPropagation();
});
const resizeObserver = new ResizeObserver(measure);
resizeObserver.observe(panel);
addEventListener('resize', measure);
copy.addEventListener('click', async () => {
  const invitation = roomInvitation;
  if (!invitation || left || copying) return;
  copying = true;
  try {
    await navigator.clipboard.writeText(invitation);
    if (closed || left || roomInvitation !== invitation) return;
    clearTimeout(copyFeedbackTimer);
    copyStatus.textContent = 'Приглашение скопировано.';
    manual.hidden = true;
    invitationLink.value = '';
    copyFeedbackTimer = window.setTimeout(() => {
      copyStatus.textContent = '';
      render();
    }, 4000);
    render();
  } catch {
    if (closed || left || roomInvitation !== invitation) return;
    clearTimeout(copyFeedbackTimer);
    copyStatus.textContent = 'Не удалось скопировать. Выделите ссылку и скопируйте вручную.';
    invitationLink.value = invitation;
    manual.hidden = false;
    setExpanded(true);
    invitationLink.focus();
  } finally {
    copying = false;
  }
});
invitationLink.addEventListener('focus', () => invitationLink.select());
const engine = createSyncEngine({
  async apply(videoId, sample) {
    if (tabId === undefined) return 'blocked';
    appliedToken = adapterToken;
    return applyResultSchema.parse(await browser.tabs.sendMessage(tabId, {
      type: 'room-player-apply', target, adapterToken, videoRevision: currentGeneration, playback: { videoId, ...sample },
    }, { frameId: 0 }));
  },
  stop() {
    if (tabId !== undefined) void browser.tabs.sendMessage(tabId, { type: 'room-player-stop', target, adapterToken: appliedToken }, { frameId: 0 }).catch(() => {});
  },
  sendCommand: command => transport.sendCommand(command),
  onError(message) { syncError = message; render(); },
});
const transport = createRoomTransport((state) => {
  lastState = state;
  if (!state.connected || !state.roomReady) {
    following = false; lastReconciled = '';
    engine.update({ playback: invitationRoomSchema.safeParse(state.room).data?.playback,
      connected: false, serverTimeOffset: state.serverTimeOffset });
    switchVideo.disabled = true;
  } else void reconcile();
  retry.hidden = generationBlocksEntry(state.recovery?.failure) ||
    (state.phase !== 'error' && !state.presenceError && !state.roomError && state.recovery?.phase !== 'waiting');
  stopRecovery.hidden = state.recovery?.phase !== 'running' && state.recovery?.phase !== 'waiting';
  renderParticipants(participants, state);
  const room = invitationRoomSchema.safeParse(state.room);
  if (!room.success) showPlayerStatus();
  else returnVideo.href = `https://www.youtube.com/watch?v=${room.data.playback.videoId}`;
  render();
});
const ready = (async () => {
  tabId = (await browser.tabs.getCurrent())?.id;
  const response = await browser.runtime.sendMessage({ type: 'room-tab-ready', backendGeneration, target });
  bindingReady = !!response?.binding;
  if (response?.binding) configureRoom(response.binding.key, response.binding.name);
  if (response?.binding) await transport.watchRoom(response.binding.key);
  else await transport.start();
  await updateCatalogStatus();
})();
async function reconcile() {
  if (reconciling || closed || !bindingReady || tabId === undefined || left) return;
  reconciling = true;
  try {
    const state = transport.status();
    const room = invitationRoomSchema.safeParse(state.room);
    if (!room.success || !state.connected || !state.roomReady) return;
    const route = routeSchema.parse(await browser.tabs.sendMessage(tabId, { type: 'room-player-context', target }, { frameId: 0 }));
    const playback = room.data.playback;
    const key = `${playback.revision}:${route.videoId}:${route.sequence}`;
    if (key === lastReconciled && !forceReturn) return;
    const force = forceReturn;
    const response = await browser.runtime.sendMessage({ type: 'room-tab-view', backendGeneration, target,
      playback, route, force, ownCommand: playback.actorUid === state.uid });
    if (closed || left) return;
    if (response?.error) throw new Error(response.error);
    if (response?.stale) return;
    const view = viewSchema.parse(response?.view);
    const now = transport.status();
    const latest = invitationRoomSchema.safeParse(now.room);
    if (!now.connected || !now.roomReady || !latest.success || latest.data.playback.revision !== playback.revision) return;
    forceReturn = false;
    viewError = null;
    lastReconciled = key;
    following = view.mode === 'following' && !response.navigating && route.videoId === playback.videoId;
    switchVideo.hidden = !route.videoId || route.videoId === playback.videoId;
    switchVideo.disabled = changing || !state.connected || !state.roomReady;
    const routeChanged = currentRouteSequence !== route.sequence;
    // Content script удаляет адаптер при каждом локальном переходе. Даже если
    // между сверками успели уйти и вернуться к тому же видео, нужен новый apply.
    if (routeChanged) engine.update({ playback, connected: false, serverTimeOffset: state.serverTimeOffset });
    if (currentGeneration !== playback.videoRevision || routeChanged) {
      currentGeneration = playback.videoRevision;
      currentRouteSequence = route.sequence;
      adapterToken = crypto.randomUUID();
      localPlayerStatus = 'loading';
    }
    if (!following) showPlayerStatus(response.navigating ? 'loading' : 'different-video');
    engine.update({ playback, connected: following, serverTimeOffset: state.serverTimeOffset });
    render();
  } catch {
    if (!closed && !left) {
      following = false;
      engine.update({ playback: undefined, connected: false, serverTimeOffset: 0 });
      viewError = 'Не удалось обновить просмотр. Повторите действие.';
      render();
    }
  } finally { reconciling = false; }
}
const reconcileTimer = setInterval(() => { void reconcile(); }, 250);

// Ошибка worker не должна оставлять необработанный Promise.
void ready.catch(() => { actionError = 'Не удалось восстановить комнату. Откройте приглашение ещё раз.'; render(); });

async function release() {
  // Сначала удаляем сохранённую привязку, чтобы reload не вернул вышедшего.
  const response = await browser.runtime.sendMessage({ type: 'room-tab-release', backendGeneration, target });
  if (!response?.accepted) throw new Error();
  left = true;
  bindingReady = false;
  following = false;
  roomName = null; roomInvitation = null;
  actionError = null; syncError = null; switchError = null; viewError = null;
  catalogError = null;
  copyStatus.textContent = ''; manual.hidden = true; invitationLink.value = '';
  expanded = false;
  transport.unwatchRoom();
  clearTimeout(renderFrame); present();
  switchVideo.hidden = true;
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const event = playerEventSchema.safeParse(message);
  if (event.success && event.data.target === target && tabId !== undefined
    && isPlayerEventSender(sender, browser.runtime.id, tabId)) {
    if (!following || event.data.adapterToken !== adapterToken || event.data.videoRevision !== currentGeneration) return;
    if (event.data.type === 'room-player-status') {
      showPlayerStatus(event.data.status);
      engine.playerStatus(event.data.status, event.data.localSeek);
    }
    else if (event.data.type === 'room-player-interaction') engine.playerInteraction(event.data.active);
    else {
      const current = invitationRoomSchema.safeParse(transport.status().room);
      if (current.success && current.data.playback.videoId === event.data.videoId) void engine.intent(event.data.intent);
    }
    sendResponse({ accepted: true });
    return;
  }
  // runtime messages не доступны странице YouTube. Content scripts также
  // не могут читать UID/данные или выбирать комнату от имени страницы.
  if (!isPopupSender(sender, browser.runtime.id)) return;
  const request = sessionRequestSchema.safeParse(message);
  if (!request.success || request.data.target !== target) return;
  const action = request.data;
  const popupState = (): PopupSessionState => ({ ...transport.status(), roomName, roomInvitation });
  const run = async () => {
    if (action.action === 'status') return popupState();
    if (action.action !== 'stop' && action.action !== 'retry') await ready;
    if (action.action === 'retry') await transport.retry();
    if (action.action === 'stop') transport.stop();
    if (action.action === 'watch') { left = false; await transport.watchRoom(action.key); }
    if (action.action === 'unwatch') await release();
    if (action.action === 'create') {
      left = false;
      await transport.createRoom(action.playback, action.metadata);
      const invitation = transport.status().invitation;
      const config = firebaseConfig();
      const key = invitation && config ? invitationKey(invitation, config.invitationBaseUrl) : null;
      if (key) {
        const actualRoom = invitationRoomSchema.parse(transport.status().room);
        const response = await browser.runtime.sendMessage({
          type: 'room-tab-bind', backendGeneration, target, key, videoId: actualRoom.playback.videoId, name: actualRoom.metadata.name,
        });
        if (!response?.accepted) throw new Error();
        showCatalogError(response.catalogError);
        bindingReady = true;
        configureRoom(key, actualRoom.metadata.name);
        lastReconciled = '';
        void reconcile();
      }
    }
    return popupState();
  };
  run().then(sendResponse, () => sendResponse({ error: 'Не удалось выполнить действие.' }));
  return true;
});

stopRecovery.addEventListener('click', () => transport.stop());
const recoveryTicker = setInterval(() => { if (lastState?.recovery?.retryAt) render(); }, 1000);
retry.addEventListener('click', () => {
  actionError = null;
  void transport.retry().catch(() => { actionError = 'Не удалось подключиться. Повторите попытку.'; }).finally(render);
});
catalogRetry.addEventListener('click', () => { void updateCatalogStatus(true).catch(() => showCatalogError('Повторите сохранение.')); });
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') void updateCatalogStatus().catch(() => {});
});
leave.addEventListener('click', () => {
  if (leaving) return;
  leaving = true; actionError = null; render();
  void release().catch(() => { actionError = 'Не удалось выйти из комнаты. Повторите попытку.'; })
    .finally(() => { leaving = false; render(); });
});
addEventListener('pagehide', () => { closed = true; clearInterval(recoveryTicker); disposeDrag(); clearTimeout(renderFrame); clearTimeout(copyFeedbackTimer); resizeObserver.disconnect(); removeEventListener('resize', measure); clearInterval(reconcileTimer); engine.dispose(); void transport.close(); }, { once: true });

returnVideo.addEventListener('click', event => {
  event.preventDefault();
  if (closed || left) return;
  // Ошибку самого видео по-прежнему можно устранить перезагрузкой.
  if (localPlayerStatus === 'unavailable' && following) {
    void browser.tabs.update(tabId!, { url: returnVideo.href }).catch(() => { actionError = 'Не удалось перезагрузить видео. Повторите действие.'; render(); });
    return;
  }
  actionError = null; render();
  void (async () => {
    await transport.refresh();
    if (closed || left) return;
    if (!transport.status().roomReady) throw new Error();
    forceReturn = true;
    lastReconciled = '';
    await reconcile();
  })().catch(() => { actionError = 'Не удалось вернуться в комнату. Повторите действие.'; render(); });
});
switchVideo.addEventListener('click', () => {
  if (changing || closed || left || tabId === undefined) return;
  changing = true;
  switchVideo.disabled = true;
  switchError = null;
  switchStatus.textContent = 'Меняем видео…';
  render();
  const actionAt = Date.now();
  let pendingStored = false;
  let submitted = false;
  let uncertain = false;
  void (async () => {
    const state = transport.status();
    const room = invitationRoomSchema.safeParse(state.room);
    if (!state.connected || !state.roomReady || !room.success) throw new Error('Нет связи с сервером. Повторите после подключения.');
    const snapshot = await browser.tabs.sendMessage(tabId!, { type: 'room-player-snapshot', target }, { frameId: 0 });
    if (snapshot?.error) throw new Error(snapshot.error);
    const sample = initialPlaybackSchema.parse(snapshot?.playback);
    const capturedRoute = routeSchema.parse(snapshot?.route);
    const currentRoute = routeSchema.parse(await browser.tabs.sendMessage(tabId!, { type: 'room-player-context', target }, { frameId: 0 }));
    if (capturedRoute.videoId !== currentRoute.videoId || capturedRoute.sequence !== currentRoute.sequence || closed || left) {
      throw new Error('Видео изменилось. Повторите действие на текущем ролике.');
    }
    const sampledAt = snapshot.sampledAt;
    if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt) || sampledAt < actionAt) throw new Error('Не удалось прочитать состояние плеера.');
    const command = createVideoSwitchCommand(sample, room.data.playback.revision,
      { actionAt: actionAt + state.serverTimeOffset, sampledAt: sampledAt + state.serverTimeOffset });
    const pending = await browser.runtime.sendMessage({ type: 'room-tab-switch-pending', backendGeneration, target,
      pending: { commandId: command.commandId, videoId: sample.videoId } });
    if (!pending?.accepted || closed || left) throw new Error('Не удалось подготовить смену видео.');
    pendingStored = true;
    const finalRoute = routeSchema.parse(await browser.tabs.sendMessage(tabId!, { type: 'room-player-context', target }, { frameId: 0 }));
    if (closed || left || finalRoute.videoId !== capturedRoute.videoId || finalRoute.sequence !== capturedRoute.sequence) {
      throw new Error('Видео изменилось. Повторите действие на текущем ролике.');
    }
    submitted = true;
    const result = await transport.sendCommand(command);
    if (closed || left) return;
    if (result.status === 'rejected') {
      uncertain = result.reason === 'offline';
      if (result.reason !== 'offline') await browser.runtime.sendMessage({ type: 'room-tab-switch-pending', backendGeneration, target, pending: null });
      throw new Error(result.reason === 'offline' ? 'Связь прервалась. Получим актуальное состояние после подключения.'
        : result.reason === 'busy' ? 'Дождитесь завершения предыдущего действия и повторите.' : 'Смена не принята. В комнате уже другое состояние; повторите действие или вернитесь в комнату.');
    }
    switchStatus.textContent = 'Видео комнаты изменено.';
    lastReconciled = '';
    await reconcile();
  })().catch(async error => {
    if (pendingStored && !uncertain && !closed && !left && (!submitted || transport.status().connected)) {
      await browser.runtime.sendMessage({ type: 'room-tab-switch-pending', backendGeneration, target, pending: null }).catch(() => {});
    }
    if (!closed && !left) {
      switchError = error instanceof Error ? error.message : 'Не удалось сменить видео. Повторите действие.';
      switchStatus.textContent = switchError; render();
    }
  }).finally(() => {
    changing = false;
    switchVideo.disabled = !transport.status().connected || !transport.status().roomReady;
    render();
  });
});
