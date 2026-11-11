import { t } from '../i18n';
import type { TransportState } from './transport';

export function connectionMessage(state: TransportState): string {
  const recovery = state.recovery;
  const local = state.room && (!state.connected || !state.roomReady) ? t('localViewingSuffix') : '';
  if (recovery?.phase === 'stopped') return t('attemptsStopped') + local;
  if (state.error) return state.error + (recovery?.retryAt ? ' ' + t('retryCountdown', String(Math.max(0, Math.ceil((recovery.retryAt - Date.now()) / 1000)))) : '') + local;
  if (state.room && !state.connected) return t('serverDisconnected') + local;
  if (state.room && !state.roomReady && recovery?.phase === 'running') return t('loadingRoomState');
  if (state.phase === 'ready' && !state.connected) return t('serverDisconnected');
  if (state.roomError) return state.roomError;
  if (state.phase !== 'ready') return t('connecting');
  if (!state.connected) return t('serverDisconnected');
  if (state.room && !state.roomReady) return t('loadingRoomState');
  if (state.presenceError) return state.presenceError;
  if (state.creating) return t('creatingRoom');
  if (state.invitation) return t('roomCreated');
  return state.room ? t('roomConnected') : t('noRoomSelected');
}
