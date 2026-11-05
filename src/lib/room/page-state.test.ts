import { describe, expect, it } from 'vitest';
import { pageState } from './page-state';
import type { TransportState } from './transport';

const ready: TransportState = { phase: 'ready', connected: true, roomReady: true, uid: null,
  room: {}, roomError: null, error: null, invitation: null, creating: false, creationError: null,
  serverTimeOffset: 0, participants: [{ number: 1, color: 'red', isSelf: true }], presenceError: null };
const view = { following: true, player: 'ready' as const };
describe('pageState', () => {
  it('не выдаёт старый ready и число за актуальные при offline/refresh/error', () => {
    expect(pageState(ready, view)).toMatchObject({ text: 'Смотрим вместе', count: 1 });
    for (const delta of [{ connected: false }, { roomReady: false }, { roomError: 'Ошибка комнаты' }, { presenceError: 'Ошибка presence' }]) {
      const result = pageState({ ...ready, ...delta }, view);
      expect(result.count).toBeNull();
      expect(result.text).not.toBe('Смотрим вместе');
    }
    expect(pageState({ ...ready, connected: false, roomError: 'Старая ошибка' }, view).text).toBe('Нет связи с сервером.');
    expect(pageState(ready, view).count).toBe(1);
  });
  it('отличает detached от загрузки following', () => {
    expect(pageState(ready, { following: false, player: 'different-video' }).text).toContain('Локальный просмотр');
    expect(pageState(ready, { following: false }).text).toContain('Ожидаем');
  });
  it.each(['ad', 'buffering', 'autoplay-blocked', 'unavailable'] as const)('показывает %s вместо ready', player => {
    expect(pageState(ready, { ...view, player }).text).not.toBe('Смотрим вместе');
  });
  it('сохраняет offline при ошибке действия', () => {
    expect(pageState({ ...ready, connected: false }, { ...view, problem: true })).toMatchObject({ text: 'Нет связи с сервером.', problem: true });
  });
});
