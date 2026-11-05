import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomTransport } from './transport';
import type { TransportState } from './transport';
import { createPlaybackCommand, createVideoSwitchCommand } from '../playback/commands';

const mocks = vi.hoisted(() => ({
  readRoom: vi.fn(), submit: vi.fn(), service: vi.fn(),
  listeners: new Map<string, (snapshot: { val: () => unknown; exists: () => boolean }) => void>(),
}));
vi.mock('../firebase/client', () => ({
  getFirebaseClient: async () => ({ database: {}, uid: 'self', readRoom: mocks.readRoom }),
  closeFirebaseClient: async () => {}, authErrorMessage: () => 'Auth error',
}));
vi.mock('../firebase/config', () => ({ backendGeneration: 'emulator-v1', releaseVersion: '0.2.0', firebaseConfig: () => ({ invitationBaseUrl: 'https://invite.example/', backendGeneration: 'emulator-v1' }) }));
vi.mock('../generation-availability', () => ({ createGenerationAvailability: () => ({ read: mocks.service }) }));
vi.mock('firebase/database', () => ({
  ref: (_database: unknown, path: string) => path,
  onValue: (path: string, callback: typeof mocks.listeners extends Map<string, infer V> ? V : never) => {
    mocks.listeners.set(path, callback);
    return () => { mocks.listeners.delete(path); };
  },
  goOnline: vi.fn(), goOffline: vi.fn(), set: vi.fn(), serverTimestamp: () => ({ '.sv': 'timestamp' }),
}));
vi.mock('./commands', () => ({ submitPlaybackCommand: (...args: unknown[]) => mocks.submit(...args) }));
vi.mock('./presence', () => ({
  createPresence: () => ({ close() {}, setConnected() {}, retry() {} }),
  roomParticipants: () => [],
}));

const key = 'a'.repeat(64);
const sample = { videoId: 'aqz-KE-bpKQ', positionSeconds: 10, playbackRate: 1, isPlaying: false };
const room = (revision = 0) => ({ metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
  ...sample, revision, kind: 'playback' as const, videoRevision: 0, commandId: `command-${revision}`, actorUid: 'other', actionAt: 1000, sampledAt: 1000, updatedAt: 1000,
}, presence: { other: { connections: { one: { connectedAt: 1000 } } } } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function emit(path: string, value: unknown) {
  mocks.listeners.get(path)!({ val: () => value, exists: () => value !== null });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const changes: TransportState[] = [];
  const transport = createRoomTransport(state => changes.push(state));
  const starting = transport.start();
  await flush();
  emit('.info/connected', true);
  await starting;
  await transport.watchRoom(key);
  return { transport, changes };
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.service.mockReset().mockResolvedValue({ state: 'unknown' });
  mocks.readRoom.mockReset().mockResolvedValue(room());
  mocks.submit.mockReset().mockResolvedValue({ status: 'rejected', reason: 'offline', playback: null });
});

describe('актуальность комнаты после reconnect', () => {
  it('неподдерживаемая комната блокирует sync; удаление показывает актуальную ошибку', async () => {
    const { transport } = await setup();
    emit(`rooms/${key}`, { playback: room().playback });
    expect(transport.status()).toMatchObject({ roomReady: false, roomError: expect.stringContaining('Формат комнаты'), participants: [] });
    emit(`rooms/${key}`, null);
    expect(transport.status()).toMatchObject({ roomReady: false, roomError: 'Комната не найдена.' });
    await transport.close();
  });

  it.each([1, 2])('не разрешает sync до server read; поздняя revision %s не откатывает playback и presence подписки', async incomingRevision => {
    const { transport, changes } = await setup();
    emit('.info/connected', false);
    const read = deferred<unknown>();
    mocks.readRoom.mockReturnValueOnce(read.promise);
    emit('.info/connected', true);
    await flush();
    expect(transport.status()).toMatchObject({ connected: true, roomReady: false });
    const latest = { ...room(2), presence: { ...room(2).presence, self: { connections: { two: { connectedAt: 2000 } } } } };
    emit(`rooms/${key}`, latest);
    expect(transport.status().roomReady).toBe(false);
    read.resolve(room(incomingRevision));
    await flush();
    expect(transport.status()).toMatchObject({ roomReady: true, room: latest });
    expect(changes.filter(s => s.roomReady).at(-1)?.room).toEqual(latest);
    await transport.close();
  });

  it('не принимает поздний read прошлого соединения или покинутой комнаты', async () => {
    const { transport } = await setup();
    const read = deferred<unknown>();
    mocks.readRoom.mockReturnValueOnce(read.promise);
    emit('.info/connected', false);
    emit('.info/connected', true);
    await flush();
    const signal: AbortSignal = mocks.readRoom.mock.calls.at(-1)![1];
    emit('.info/connected', false);
    expect(signal.aborted).toBe(true);
    read.resolve(room(99));
    await flush();
    expect(transport.status()).toMatchObject({ connected: false, roomReady: false, room: room() });
    const afterLeave = deferred<unknown>();
    mocks.readRoom.mockReturnValueOnce(afterLeave.promise);
    emit('.info/connected', true);
    await flush();
    transport.unwatchRoom();
    afterLeave.resolve(room(100));
    await flush();
    expect(transport.status()).toMatchObject({ room: null, roomReady: false });
    await transport.close();
  });

  it('ошибка свежего чтения оставляет sync заблокированным; retry читает сервер заново', async () => {
    const { transport } = await setup();
    emit('.info/connected', false);
    mocks.readRoom.mockRejectedValueOnce(new Error('network'));
    emit('.info/connected', true);
    await flush();
    expect(transport.status()).toMatchObject({ roomReady: false, roomError: expect.stringContaining('актуальное состояние') });
    // Presence update не скрывает ошибку свежего чтения.
    emit(`rooms/${key}`, room());
    expect(transport.status().roomError).toContain('актуальное состояние');
    mocks.readRoom.mockResolvedValueOnce(room(3));
    const retrying = transport.retry();
    await flush(); emit('.info/connected', true);
    await retrying;
    expect(transport.status()).toMatchObject({ roomReady: true, roomError: null, room: room(3) });
    await transport.close();
  });

  it.each(['playback', 'switch-video'] as const)('проверка %s помнит обрыв даже после быстрого восстановления связи', async kind => {
    const { transport } = await setup();
    const command = kind === 'playback' ? createPlaybackCommand(sample, 0)
      : createVideoSwitchCommand({ ...sample, videoId: 'dQw4w9WgXcQ' }, 0, { actionAt: Date.now(), sampledAt: Date.now() });
    await transport.sendCommand(command);
    const canWrite = mocks.submit.mock.calls[0]![4] as () => unknown;
    const signal = mocks.submit.mock.calls[0]![5] as AbortSignal;
    expect(canWrite()).toBeNull();
    emit('.info/connected', false);
    emit('.info/connected', true);
    await flush();
    expect(transport.status().roomReady).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(canWrite()).toBe('offline');
    await transport.sendCommand(command);
    expect((mocks.submit.mock.calls[1]![4] as () => unknown)()).toBeNull();
    transport.unwatchRoom();
    expect(canWrite()).toBe('inactive');
    await transport.close();
  });
});

it('объявление не отключает здоровую сессию при refresh; поздний connected после stop игнорируется', async () => {
  const { transport } = await setup();
  const requests = mocks.service.mock.calls.length;
  mocks.service.mockResolvedValue({ state: 'unavailable', reason: 'quota' });
  await transport.refresh();
  expect(transport.status()).toMatchObject({ connected: true, roomReady: true });
  expect(mocks.service.mock.calls).toHaveLength(requests);
  transport.stop();
  emit('.info/connected', true);
  expect(transport.status()).toMatchObject({ connected: false, roomReady: false, recovery: { phase: 'stopped' } });
  await transport.close();
});
