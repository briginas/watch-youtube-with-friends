import { randomBytes, randomUUID } from 'node:crypto';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectDatabaseEmulator, forceWebSockets, getDatabase, goOffline, goOnline, onValue, ref, type Database } from 'firebase/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaybackCommand, createVideoSwitchCommand, type PlaybackCommand } from '../../src/lib/playback/commands';
import { playbackSchema, type Playback } from '../../src/lib/playback/model';
import { submitPlaybackCommand } from '../../src/lib/room/commands';

forceWebSockets();
const apps: FirebaseApp[] = [];
type Client = { database: Database; uid: string; token: string };
let first: Client;
let second: Client;
const sample = { videoId: 'aqz-KE-bpKQ', positionSeconds: 12.5, playbackRate: 1, isPlaying: false };

async function client(): Promise<Client> {
  const app = initializeApp({
    projectId: 'demo-watch-together', apiKey: 'demo-key-not-a-production-credential',
    databaseURL: 'https://demo-watch-together-default-rtdb.firebaseio.com',
  }, randomUUID());
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const database = getDatabase(app);
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  const { user } = await signInAnonymously(auth);
  return { database, uid: user.uid, token: await user.getIdToken() };
}

// Независимое чтение сервера: optimistic cache SDK не доказывает принятие команды.
async function request(who: Client, key: string, method = 'GET', value?: unknown, suffix = '') {
  const url = new URL(`http://127.0.0.1:9000/rooms/${key}${suffix}.json`);
  url.searchParams.set('ns', 'demo-watch-together-default-rtdb');
  url.searchParams.set('auth', who.token);
  return fetch(url, { method, headers: { 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

async function room() {
  const key = randomBytes(32).toString('hex');
  expect((await request(first, key, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
    ...sample, actionAt: 0, sampledAt: 0, revision: 0, kind: 'playback' as const, videoRevision: 0, commandId: randomUUID(), actorUid: first.uid, updatedAt: { '.sv': 'timestamp' },
  } })).status).toBe(200);
  return key;
}

async function read(key: string): Promise<Playback> {
  const response = await request(second, key);
  expect(response.status).toBe(200);
  return playbackSchema.parse((await response.json()).playback);
}

async function observe(who: Client, key: string) {
  const values: Playback[] = [];
  let unsubscribe = () => {};
  await new Promise<void>((resolve, reject) => {
    unsubscribe = onValue(ref(who.database, `rooms/${key}/playback`), snapshot => {
      values.push(playbackSchema.parse(snapshot.val()));
      resolve();
    }, reject);
  });
  return { values, close: () => unsubscribe() };
}

beforeAll(async () => {
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  [first, second] = await Promise.all([client(), client()]);
  expect(first.uid).not.toBe(second.uid);
});
afterAll(async () => {
  apps.forEach(app => goOffline(getDatabase(app)));
  await Promise.all(apps.map(app => deleteApp(app)));
});

describe('транзакции playback под продуктовыми Rules', () => {
  it('из пустого cache записывает play/pause, seek и rate с серверной меткой и автором', async () => {
    const key = await room();
    let revision = 0;
    for (const [who, changes] of [
      [second, { isPlaying: true }], [first, { positionSeconds: 50.25 }],
      [second, { playbackRate: 1.5 }], [first, { isPlaying: false }],
    ] as const) {
      const before = await read(key);
      const base = {
        videoId: before.videoId, positionSeconds: before.positionSeconds,
        playbackRate: before.playbackRate, isPlaying: before.isPlaying,
      };
      const command = createPlaybackCommand({ ...base, ...changes }, revision);
      const result = await submitPlaybackCommand(who.database, key, who.uid, command);
      expect(result.status).toBe('committed');
      revision++;
      const stored = await read(key);
      expect(stored).toMatchObject({ ...changes, revision, commandId: command.commandId, actorUid: who.uid });
      expect(stored.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
      expect(stored.updatedAt).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(result.playback).toMatchObject({ revision, commandId: command.commandId });
    }
  });

  it('при одинаковом времени двух UID принимает одну команду без промежуточного события проигравшей', async () => {
    const key = await room();
    const observations = await Promise.all([observe(first, key), observe(second, key)]);
    try {
      const timing = { actionAt: Date.now(), sampledAt: Date.now() };
      const commands = [createPlaybackCommand({ ...sample, positionSeconds: 40 }, 0, timing),
        createPlaybackCommand({ ...sample, isPlaying: true, positionSeconds: 70, playbackRate: 2 }, 0, timing)];
      const results = await Promise.all([submitPlaybackCommand(first.database, key, first.uid, commands[0]!),
        submitPlaybackCommand(second.database, key, second.uid, commands[1]!)]);
      expect(results.filter(result => result.status === 'committed')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: 'stale' });
      const stored = await read(key);
      expect(stored.revision).toBe(1);
      expect(rejected?.playback).toMatchObject({ revision: 1, commandId: stored.commandId });
      await Promise.all(observations.map(async observation => {
        await expect.poll(() => observation.values.at(-1)?.commandId).toBe(stored.commandId);
        expect(observation.values.every(value => value.revision === 0 || value.commandId === stored.commandId)).toBe(true);
      }));
    } finally { observations.forEach(observation => observation.close()); }
  });

  it.each([false, true])('разные UID и обратная доставка newerFirst=%s сходятся к позднему действию', async newerFirst => {
    const key = await room();
    const at = Date.now() - 1000;
    const earlier = createPlaybackCommand({ ...sample, positionSeconds: 40 }, 0, { actionAt: at, sampledAt: at + 120 });
    const later = createPlaybackCommand({ ...sample, positionSeconds: 300 }, 0, { actionAt: at + 500, sampledAt: at + 620 });
    const deliveries = newerFirst ? [[second, later], [first, earlier]] as const : [[first, earlier], [second, later]] as const;
    for (const [who, command] of deliveries) await submitPlaybackCommand(who.database, key, who.uid, command);
    const stored = await read(key);
    expect(stored).toMatchObject({ commandId: later.commandId, positionSeconds: 300, actionAt: at + 500 });
    expect(await submitPlaybackCommand(second.database, key, second.uid, later)).toMatchObject({ status: 'duplicate' });
    expect(await read(key)).toEqual(stored);
  });

  it('повтор принятой команды и её поздний replay не повышают revision', async () => {
    const key = await room();
    const command = createPlaybackCommand({ ...sample, isPlaying: true }, 0);
    expect((await submitPlaybackCommand(first.database, key, first.uid, command)).status).toBe('committed');
    const accepted = await read(key);
    expect(await submitPlaybackCommand(first.database, key, first.uid, command)).toMatchObject({ status: 'duplicate' });
    expect(await read(key)).toEqual(accepted);
    const next = createPlaybackCommand({ ...sample, positionSeconds: 99 }, 1);
    expect((await submitPlaybackCommand(second.database, key, second.uid, next)).status).toBe('committed');
    const latest = await read(key);
    expect(await submitPlaybackCommand(first.database, key, first.uid, command)).toMatchObject({
      status: 'rejected', reason: 'stale', playback: { revision: 2, commandId: next.commandId },
    });
    expect(await read(key)).toEqual(latest);
  });

  it('отклоняет старую/будущую базу и смену видео, не записывая данные', async () => {
    const key = await room();
    const accepted = createPlaybackCommand({ ...sample, positionSeconds: 50 }, 0);
    await submitPlaybackCommand(second.database, key, second.uid, accepted);
    const before = await read(key);
    for (const [command, reason] of [
      [createPlaybackCommand(sample, 0, { actionAt: accepted.actionAt - 1, sampledAt: accepted.sampledAt }), 'stale'],
      [createPlaybackCommand(sample, 2), 'stale'],
      [createPlaybackCommand({ ...sample, videoId: 'dQw4w9WgXcQ' }, 1), 'different-video'],
      [{ ...accepted, baseRevision: 1, positionSeconds: 100 }, 'command-id-conflict'],
    ] as const) {
      expect(await submitPlaybackCommand(first.database, key, first.uid, command)).toMatchObject({ status: 'rejected', reason });
      expect(await read(key)).toEqual(before);
    }
    // Даже в обход клиентской проверки Rules не принимают устаревшую запись.
    expect((await request(first, key, 'PUT', {
      ...before, commandId: randomUUID(), actorUid: first.uid, updatedAt: { '.sv': 'timestamp' },
    }, '/playback')).status).toBe(401);
    expect(await read(key)).toEqual(before);
  });

  it('не создаёт отсутствующую комнату и не начинает команды при offline/inactive', async () => {
    const key = randomBytes(32).toString('hex');
    const command = createPlaybackCommand(sample, 0);
    expect(await submitPlaybackCommand(first.database, key, first.uid, command)).toEqual({
      status: 'rejected', reason: 'unavailable', playback: null,
    });
    for (const reason of ['offline', 'inactive'] as const) {
      expect(await submitPlaybackCommand(first.database, key, first.uid, command, () => reason)).toEqual({
        status: 'rejected', reason, playback: null,
      });
    }
    expect(await (await request(first, key)).json()).toBeNull();
    const existing = await room();
    let active = true;
    const writing = submitPlaybackCommand(first.database, existing, first.uid, command, () => active ? null : 'inactive');
    active = false;
    expect(await writing).toMatchObject({ status: 'rejected', reason: 'inactive' });
    expect((await read(existing)).revision).toBe(0);
  });

  it.each(['playback', 'switch-video'] as const)('общий шлюз %s отклоняет параллельную операцию и освобождает путь после ошибки Rules', async kind => {
    const key = await room();
    const command = kind === 'playback' ? createPlaybackCommand(sample, 0) : createVideoSwitchCommand(
      { ...sample, videoId: 'dQw4w9WgXcQ' }, 0, { actionAt: Date.now(), sampledAt: Date.now() });
    const results = await Promise.all([submitPlaybackCommand(first.database, key, first.uid, command),
      submitPlaybackCommand(first.database, key, first.uid, command)]);
    expect(results.map(result => result.status).sort()).toEqual(['committed', 'rejected']);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: 'busy' });
    // Автор не совпадает с Anonymous Auth: сервер отклоняет корректную по структуре команду.
    const state = await read(key);
    const next: PlaybackCommand = createPlaybackCommand({ ...sample, videoId: state.videoId, positionSeconds: 10 }, 1,
      { actionAt: Date.now(), sampledAt: Date.now() }, state.videoRevision);
    await expect(submitPlaybackCommand(first.database, key, second.uid, next)).rejects.toThrow();
    expect((await read(key)).revision).toBe(1);
    expect((await submitPlaybackCommand(first.database, key, first.uid, next)).status).toBe('committed');
    expect((await read(key)).revision).toBe(2);
  });

  it.each(['playback', 'switch-video'] as const)('отмена %s до snapshot освобождает путь и не пишет после reconnect', async kind => {
    const key = await room();
    const command = kind === 'playback' ? createPlaybackCommand({ ...sample, positionSeconds: 80 }, 0) : createVideoSwitchCommand(
      { ...sample, videoId: 'dQw4w9WgXcQ' }, 0, { actionAt: Date.now(), sampledAt: Date.now() });
    const controller = new AbortController();
    goOffline(first.database);
    try {
      const pending = submitPlaybackCommand(first.database, key, first.uid, command, () => null, controller.signal);
      controller.abort();
      expect(await pending).toEqual({ status: 'rejected', reason: 'offline', playback: null });
    } finally { goOnline(first.database); }
    let unsubscribe = () => {};
    try {
      await new Promise<void>(resolve => {
        unsubscribe = onValue(ref(first.database, '.info/connected'), snapshot => {
          if (snapshot.val() === true) resolve();
        });
      });
      expect((await read(key)).revision).toBe(0);
      const next = createPlaybackCommand({ ...sample, positionSeconds: 30 }, 0);
      expect((await submitPlaybackCommand(first.database, key, first.uid, next)).status).toBe('committed');
      expect(await read(key)).toMatchObject({ revision: 1, commandId: next.commandId, positionSeconds: 30 });
    } finally { unsubscribe(); }
  });
});

it.each([false, true])('явные смены под Rules: порядок доставки reverse=%s и запрет старых поколений', async reverse => {
  const key = await room();
  const at = Date.now();
  const earlier = createVideoSwitchCommand({ ...sample, videoId: 'dQw4w9WgXcQ' }, 0, { actionAt: at, sampledAt: at });
  const later = createVideoSwitchCommand({ ...sample, videoId: 'M7lc1UVf-VE', positionSeconds: 42, playbackRate: 1.5 }, 0,
    { actionAt: at + 1, sampledAt: at + 1 });
  for (const input of reverse ? [later, earlier] : [earlier, later]) await submitPlaybackCommand(first.database, key, first.uid, input);
  const latest = await read(key);
  expect(latest).toMatchObject({ videoId: later.videoId, commandId: later.commandId, kind: 'switch-video', videoRevision: latest.revision });
  expect(await submitPlaybackCommand(first.database, key, first.uid, later)).toMatchObject({ status: 'duplicate' });
  const back = createVideoSwitchCommand(sample, latest.revision, { actionAt: at + 2, sampledAt: at + 2 });
  expect(await submitPlaybackCommand(second.database, key, second.uid, back)).toMatchObject({ status: 'committed' });
  const returned = await read(key);
  const old = createPlaybackCommand(sample, 0, { actionAt: at + 3, sampledAt: at + 3 }, 0);
  expect(await submitPlaybackCommand(first.database, key, first.uid, old)).toMatchObject({ status: 'rejected', reason: 'different-generation' });
  expect(await read(key)).toEqual(returned);
});
