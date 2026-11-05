import type { TransportState } from './transport';

export function connectionMessage(state: TransportState): string {
  const recovery = state.recovery;
  const local = state.room && (!state.connected || !state.roomReady) ? ' Синхронизация прервана. Просмотр остаётся локальным.' : '';
  if (recovery?.phase === 'stopped') return 'Попытки подключения остановлены.' + local;
  if (state.error) return state.error + (recovery?.retryAt ? ` Следующая попытка через ${Math.max(0, Math.ceil((recovery.retryAt - Date.now()) / 1000))} с.` : '') + local;
  if (state.room && !state.connected) return 'Нет связи с сервером.' + local;
  if (state.room && !state.roomReady && recovery?.phase === 'running') return 'Получаем актуальное состояние комнаты…';
  if (state.phase === 'ready' && !state.connected) return 'Нет связи с сервером.';
  if (state.roomError) return state.roomError;
  if (state.phase !== 'ready') return 'Подключаемся…';
  if (!state.connected) return 'Нет связи с сервером.';
  if (state.room && !state.roomReady) return 'Получаем актуальное состояние комнаты…';
  if (state.presenceError) return state.presenceError;
  if (state.creating) return 'Создаём комнату…';
  if (state.invitation) return 'Комната создана. Приглашение готово.';
  return state.room ? 'Комната подключена.' : 'Подключено. Комната ещё не выбрана.';
}
