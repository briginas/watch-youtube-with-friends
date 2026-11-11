import { t } from '../i18n';
import type { TransportState } from './transport';
import { connectionMessage } from './status';
import type { PlayerStatus } from '../player/youtube-player';

export const playerMessages: Partial<Record<PlayerStatus, string>> = {
  ad: t('playerAd'),
  buffering: t('playerBuffering'),
  'autoplay-blocked': t('playerAutoplayBlocked'),
  missing: t('playerMissing'),
  loading: t('playerLoading'),
  unavailable: t('playerUnavailable'),
  unsupported: t('playerUnsupported'),
  'different-video': t('playerDifferentVideo'),
};

export function pageState(state: TransportState, view: {
  following: boolean; player?: PlayerStatus; problem?: boolean; left?: boolean;
}) {
  const count = state.connected && state.roomReady && !state.roomError && !state.presenceError
    ? state.participants.length : null;
  let text: string;
  let synced = false;
  let buffering = false;
  if (view.left) text = t('roomLeft');
  else if (state.recovery && (state.error || state.recovery.phase === 'stopped' || (state.room && (!state.connected || !state.roomReady)))) text = connectionMessage(state);
  else if (state.error) text = state.error;
  else if (state.phase === 'ready' && !state.connected) text = t('serverDisconnected');
  else if (state.roomError) text = state.roomError;
  else if (state.phase !== 'ready') text = t('connecting');
  else if (!state.room && !state.roomError) text = t('noRoomSelected');
  else if (!state.roomReady) text = t('loadingRoomState');
  else if (state.presenceError) text = state.presenceError;
  else if (view.player === 'different-video') text = t('localViewing');
  else if (!view.following) text = t('playerLoading');
  else {
    const message = playerMessages[view.player ?? 'missing'];
    synced = message === undefined;
    buffering = view.player === 'buffering';
    text = message ?? t('watchingTogether');
  }
  return { text, count, synced, buffering, problem: !!(view.problem || state.error || state.roomError || state.presenceError) };
}
