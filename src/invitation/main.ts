import { backendGeneration } from '../lib/firebase/config';
import { browser } from 'wxt/browser';
import { firebaseConfig } from '../lib/firebase/config';
import { closeFirebaseClient } from '../lib/firebase/client';
import { createReadOnlyEntry } from '../lib/room/read-only-entry';
import { invitationRequestSchema, isInvitationSender } from '../lib/room/invitation';
import { failureMessage, generationBlocksEntry } from '../lib/connection-error';
import type { AttemptState } from '../lib/connection-attempt';
import '../session/style.css';

const target = location.hash.slice(1);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const join = document.querySelector<HTMLButtonElement>('#join')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
let key: string | null = null;
let invitedGeneration: string | null = null;
let owner: ReturnType<typeof createReadOnlyEntry> | undefined;
let operation: string | undefined;
let last: AttemptState | undefined;
let received = false;
function render(state: AttemptState) {
  last = state;
  const waiting = state.retryAt ? ` Следующая попытка через ${Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000))} с.` : '';
  status.textContent = state.phase === 'succeeded' ? 'Комната открыта во вкладке YouTube.'
    : state.phase === 'stopped' ? 'Вход отменён. Приглашение сохранено.'
      : state.failure ? failureMessage(state.failure) + waiting : 'Подключаемся…';
  join.textContent = state.phase === 'succeeded' ? 'Открыть вкладку комнаты' : 'Повторить';
  join.disabled = state.phase === 'running';
  join.hidden = generationBlocksEntry(state.failure);
  cancel.hidden = !['running', 'waiting'].includes(state.phase);
}
function stop() {
  owner?.stop();
  if (operation) void browser.runtime.sendMessage({ type: 'room-entry', action: 'cancel', operation, target }).catch(() => {});
  operation = undefined;
}
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const config = firebaseConfig();
  if (!config || !isInvitationSender(sender, browser.runtime.id, config.invitationBaseUrl)) return;
  const request = invitationRequestSchema.safeParse(message);
  if (!request.success || request.data.target !== target) return;
  if (received && request.data.key === key && request.data.backendGeneration === invitedGeneration) {
    sendResponse({ accepted: true });
    return;
  }
  received = true;
  stop(); key = request.data.key; invitedGeneration = request.data.backendGeneration; last = undefined;
  join.hidden = !key; join.disabled = false; join.textContent = 'Присоединиться'; cancel.hidden = true;
  status.textContent = key ? 'Приглашение готово. Нажмите «Присоединиться».' : 'Приглашение повреждено. Попросите новую ссылку.';
  sendResponse({ accepted: true });
});
join.addEventListener('click', () => {
  if (!key || !invitedGeneration) return;
  stop();
  const secret = key;
  let id: string;
  owner = createReadOnlyEntry({ key: secret, backendGeneration: invitedGeneration, change: render,
    async activate(signal) {
      id = crypto.randomUUID(); operation = id;
      const current = id;
      const abort = () => { void browser.runtime.sendMessage({ type: 'room-entry', action: 'cancel', operation: current, target }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      await browser.runtime.sendMessage({ type: 'room-entry', action: 'begin', operation: id, target });
      if (signal.aborted) { abort(); signal.throwIfAborted(); }
      const response = await browser.runtime.sendMessage({ type: 'room-tab-activate', backendGeneration, target, key: secret, operation: id });
      signal.throwIfAborted(); return !!response?.opened;
    },
    async open(room, signal) {
      signal.throwIfAborted();
      const response = await browser.runtime.sendMessage({ type: 'room-tab-open', backendGeneration, target, key: secret, operation: id, videoId: room.playback.videoId, name: room.metadata.name });
      if (!response?.opened) throw new Error('entry/open-failed');
    },
  });
  void owner.restart();
});
cancel.addEventListener('click', stop);
const ticker = setInterval(() => { if (last?.retryAt) render(last); }, 1000);
addEventListener('pagehide', () => { stop(); clearInterval(ticker); void closeFirebaseClient(); }, { once: true });
