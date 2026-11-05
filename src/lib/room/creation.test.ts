import { describe, expect, it } from 'vitest';
import { generateRoomKey, initialPlaybackSchema, invitationUrl } from './creation';
import { playerSnapshotRequestSchema, sessionRequestSchema } from './messages';

describe('создание комнаты', () => {
  const playback = { videoId: 'aqz-KE-bpKQ', positionSeconds: 12.5, playbackRate: 1.5, isPlaying: false };
  const target = 'c36b326c-f235-4cc2-a784-d5fa634c68aa';

  it('проверяет состояние на границе сообщения и запрещает личные/серверные поля', () => {
    const request = { type: 'room-session', backendGeneration: 'emulator-v1', target, action: 'create', playback, metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' } };
    expect(sessionRequestSchema.safeParse(request).success).toBe(true);
    for (const changes of [
      { videoId: 'bad' }, { positionSeconds: -1 }, { positionSeconds: Infinity },
      { positionSeconds: NaN }, { positionSeconds: 1e20 }, { playbackRate: 0 },
      { playbackRate: 17 }, { isPlaying: 'false' }, { volume: 0.5 },
      { actorUid: 'spoof' }, { updatedAt: 1 }, { revision: 99 },
    ]) {
      expect(sessionRequestSchema.safeParse({ ...request, playback: { ...playback, ...changes } }).success).toBe(false);
    }
    expect(initialPlaybackSchema.safeParse({ ...playback, isPlaying: true, positionSeconds: 0 }).success).toBe(true);
    expect(playerSnapshotRequestSchema.safeParse({ type: 'room-player-snapshot', target }).success).toBe(true);
    expect(playerSnapshotRequestSchema.safeParse({ type: 'room-player-snapshot', target, key: 'secret' }).success).toBe(false);
  });

  it('создаёт случайные ключи и оставляет секрет только во fragment', () => {
    const first = generateRoomKey();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(generateRoomKey()).not.toBe(first);
    const url = new URL(invitationUrl('https://invite.example/?obsolete=1', first));
    expect(url.origin + url.pathname + url.search).toBe('https://invite.example/');
    expect(new URLSearchParams(url.hash.slice(1)).get('room')).toBe(first);
    expect(new URLSearchParams(url.hash.slice(1)).get('generation')).toBe('emulator-v1');
    expect(() => invitationUrl('https://invite.example/', '../path')).toThrow();
  });
});
