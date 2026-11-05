import { expect, it } from 'vitest';
import { presentationGate, presentationSchema } from './presentation';
const message = { type: 'room-presentation', target: 'ae36ff52-afd0-4b4f-8df9-75cfe93bca94',
  sequence: 1, visible: true, name: 'Комната', width: 320, height: 80 };
it('строгий UI-контракт не принимает секреты и произвольные размеры', () => {
  expect(presentationSchema.safeParse(message).success).toBe(true);
  for (const change of [{ key: 'secret' }, { invitation: 'secret' }, { uid: 'uid' }, { width: Infinity }, { height: -1 }, { height: 99999 }, { target: 'wrong' }]) {
    expect(presentationSchema.safeParse({ ...message, ...change }).success).toBe(false);
  }
});
it('очистка побеждает все отложенные обновления', () => {
  const accept = presentationGate();
  const valid = presentationSchema.parse(message);
  expect(accept(valid)).toBe(true);
  expect(accept({ ...valid, sequence: 3, visible: false, name: null })).toBe(true);
  expect(accept({ ...valid, sequence: 2 })).toBe(false);
  expect(accept(valid)).toBe(false);
  expect(accept({ ...valid, sequence: 4 })).toBe(true);
});
