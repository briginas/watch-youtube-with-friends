import type { TransportState } from './transport';
import { connectionMessage } from './status';
import type { PlayerStatus } from '../player/youtube-player';

export const playerMessages: Partial<Record<PlayerStatus, string>> = {
  ad: 'Реклама в этой вкладке. Синхронизация продолжится после неё.',
  buffering: 'Видео загружается. Синхронизация продолжится автоматически.',
  'autoplay-blocked': 'Нажмите play, чтобы продолжить',
  missing: 'Ожидаем плеер в этой вкладке.',
  loading: 'Ожидаем загрузку видео.',
  unavailable: 'Видео недоступно в этой вкладке.',
  unsupported: 'Этот формат видео не поддерживается.',
  'different-video': 'Не синхронизируется: открыт другой ролик.',
};

export function pageState(state: TransportState, view: {
  following: boolean; player?: PlayerStatus; problem?: boolean; left?: boolean;
}) {
  const count = state.connected && state.roomReady && !state.roomError && !state.presenceError
    ? state.participants.length : null;
  let text: string;
  let synced = false;
  let buffering = false;
  if (view.left) text = 'Вы вышли из комнаты.';
  else if (state.recovery && (state.error || state.recovery.phase === 'stopped' || (state.room && (!state.connected || !state.roomReady)))) text = connectionMessage(state);
  else if (state.error) text = state.error;
  else if (state.phase === 'ready' && !state.connected) text = 'Нет связи с сервером.';
  else if (state.roomError) text = state.roomError;
  else if (state.phase !== 'ready') text = 'Подключаемся…';
  else if (!state.room && !state.roomError) text = 'Подключено. Комната ещё не выбрана.';
  else if (!state.roomReady) text = 'Получаем актуальное состояние комнаты…';
  else if (state.presenceError) text = state.presenceError;
  else if (view.player === 'different-video') text = 'Локальный просмотр · не синхронизируется';
  else if (!view.following) text = 'Ожидаем загрузку видео.';
  else {
    const message = playerMessages[view.player ?? 'missing'];
    synced = message === undefined;
    buffering = view.player === 'buffering';
    text = message ?? 'Смотрим вместе';
  }
  return { text, count, synced, buffering, problem: !!(view.problem || state.error || state.roomError || state.presenceError) };
}
