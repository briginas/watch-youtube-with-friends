import { describe, expect, it } from 'vitest';
import { roomParticipants } from './presence';

describe('участники комнаты', () => {
  it('объединяет соединения одного UID и одинаково нумерует участников во всех клиентах', () => {
    const presence = {
      z: { connections: { first: { connectedAt: 10 }, second: { connectedAt: 20 } } },
      a: { connections: { first: { connectedAt: 30 } } },
    };
    const first = roomParticipants(presence, 'z');
    const second = roomParticipants(presence, 'a');
    expect(first).toHaveLength(2);
    expect(first.map(p => p.number)).toEqual([1, 2]);
    expect(first.map(p => p.color)).toEqual(second.map(p => p.color));
    expect(new Set(first.map(p => p.color)).size).toBe(2);
    expect(first.map(p => p.isSelf)).toEqual([false, true]);
    expect(second.map(p => p.isSelf)).toEqual([true, false]);
  });

  it('пропускает пустые соединения; после выхода номера соответствуют текущему составу', () => {
    expect(roomParticipants({ a: { connections: {} }, b: { connections: { one: { connectedAt: 1 } } } }, 'b'))
      .toEqual([{ number: 1, color: 'hsl(0 70% 65%)', isSelf: true }]);
  });

  it('не использует повреждённые данные presence', () => {
    for (const value of [null, [], 'uid', { a: { connections: { x: { connectedAt: 'bad' } } } }]) {
      expect(roomParticipants(value, 'a')).toEqual([]);
    }
  });
});
