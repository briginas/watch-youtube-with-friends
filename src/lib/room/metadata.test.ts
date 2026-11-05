import { expect, it, vi } from 'vitest';
import { createRoomMetadata, roomMetadataSchema } from './metadata';
import { catalogRequestSchema } from './catalog-messages';

it('дополняет случайное число до четырёх цифр', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.00125).mockReturnValueOnce(0.99995);
  try {
    expect(createRoomMetadata().name).toBe('🎬 0012');
    expect(createRoomMetadata().name).toBe('🎬 9999');
  } finally {
    random.mockRestore();
  }
});

it('требует поколение и версию, принимает сохранённые имена и совместимые версии', () => {
  const metadata = createRoomMetadata();
  expect(metadata).toEqual({ name: expect.stringMatching(/^🎬 \d{4}$/u), createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' });
  expect(roomMetadataSchema.safeParse({ ...metadata, name: 'Комната', createdWithVersion: '0.2.1' }).success).toBe(true);
  for (const name of ['', ' ', 'a'.repeat(201), 1]) expect(roomMetadataSchema.safeParse({ ...metadata, name }).success).toBe(false);
  for (const value of [{ name: 'Старый формат' }, { ...metadata, backendGeneration: 'other' },
    { ...metadata, createdWithVersion: '0.2' }, { ...metadata, extra: true }]) expect(roomMetadataSchema.safeParse(value).success).toBe(false);
});

it('не принимает произвольные URL и неизвестные команды списка', () => {
  expect(catalogRequestSchema.safeParse({ type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'list' }).success).toBe(true);
  for (const message of [
    { type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'list', uid: 'spoof' },
    { type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'remove', key: '../rooms' },
    { type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'open', room: { key: 'a'.repeat(64), videoId: 'aqz-KE-bpKQ', name: 'A', url: 'https://evil.org' } },
    { type: 'room-catalog', backendGeneration: 'emulator-v1', action: 'save', key: 'a'.repeat(64) },
  ]) expect(catalogRequestSchema.safeParse(message).success).toBe(false);
});
