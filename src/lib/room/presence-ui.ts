import type { TransportState } from './transport';

export function renderParticipants(container: HTMLElement, state: TransportState) {
  container.replaceChildren();
  container.hidden = !state.connected || !state.roomReady || !!state.roomError || !!state.presenceError || state.participants.length === 0;
  if (container.hidden) return;
  const count = document.createElement('p');
  count.textContent = `Участников: ${state.participants.length}`;
  const list = document.createElement('ul');
  list.setAttribute('aria-label', 'Участники');
  for (const participant of state.participants) {
    const item = document.createElement('li');
    item.textContent = `Участник ${participant.number}${participant.isSelf ? ' (вы)' : ''}`;
    item.style.color = participant.color;
    list.append(item);
  }
  container.append(count, list);
}
