import { t } from '../i18n';
import type { TransportState } from './transport';

export function renderParticipants(container: HTMLElement, state: TransportState) {
  container.replaceChildren();
  container.hidden = !state.connected || !state.roomReady || !!state.roomError || !!state.presenceError || state.participants.length === 0;
  if (container.hidden) return;
  const count = document.createElement('p');
  count.textContent = t('participantCount', String(state.participants.length));
  const list = document.createElement('ul');
  list.setAttribute('aria-label', t('participants'));
  for (const participant of state.participants) {
    const item = document.createElement('li');
    item.textContent = t('participant', [String(participant.number), participant.isSelf ? t('participantSelf') : '']);
    const dot = document.createElement('span');
    dot.className = 'participant-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.backgroundColor = participant.color;
    item.prepend(dot);
    list.append(item);
  }
  container.append(count, list);
}
