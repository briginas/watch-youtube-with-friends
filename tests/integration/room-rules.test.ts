import { randomBytes, randomUUID } from 'node:crypto';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const apps: FirebaseApp[] = [];
type Client = { uid: string; token: string };
let first: Client;
let second: Client;
const timestamp = { '.sv': 'timestamp' };
const presence = () => ({ connections: { session: { connectedAt: timestamp } } });
const secret = () => randomBytes(24).toString('base64url');

async function client(): Promise<Client> {
  const app = initializeApp({ projectId: 'demo-watch-together', apiKey: 'demo-key-not-a-production-credential' }, randomUUID());
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { user } = await signInAnonymously(auth);
  return { uid: user.uid, token: await user.getIdToken() };
}

// REST проверяет серверный результат без локального optimistic cache SDK.
// Ни admin credentials, ни временной подмены Rules: только настоящие Anonymous ID tokens.
async function request(who: Client | null, path: string, method = 'GET', value?: unknown, query = '') {
  const url = new URL(`http://127.0.0.1:9000/${path}.json`);
  url.searchParams.set('ns', 'demo-watch-together-default-rtdb');
  if (who) url.searchParams.set('auth', who.token);
  for (const [name, content] of new URLSearchParams(query)) url.searchParams.set(name, content);
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

async function allowed(who: Client, path: string, method = 'GET', value?: unknown) {
  const response = await request(who, path, method, value);
  expect(response.status).toBe(200);
  return response.json();
}

async function denied(who: Client | null, path: string, method = 'GET', value?: unknown, query = '') {
  const response = await request(who, path, method, value, query);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Permission denied' });
}

function playback(who = first, changes: Record<string, unknown> = {}) {
  return {
    videoId: 'aqz-KE-bpKQ', positionSeconds: 12.5, playbackRate: 1, isPlaying: false,
    actionAt: Date.now(), sampledAt: Date.now(),
    updatedAt: timestamp, revision: 0, kind: 'playback' as const, videoRevision: 0, actorUid: who.uid, commandId: randomUUID(), ...changes,
  };
}

async function room(who = first) {
  const path = `rooms/${secret()}`;
  await allowed(who, path, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(who) });
  return path;
}

beforeAll(async () => {
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  [first, second] = await Promise.all([client(), client()]);
  expect(first.uid).not.toBe(second.uid);
});

afterAll(async () => { await Promise.all(apps.map((app) => deleteApp(app))); });

describe('RTDB Rules комнат', () => {
  it('фиксирует поколение и версию создателя; совместимый patch не меняет контракт', async () => {
    const metadata = { name: 'Generation', createdWithVersion: '0.2.1', backendGeneration: 'emulator-v1' };
    const path = `rooms/${secret()}`;
    await allowed(first, path, 'PUT', { metadata, playback: playback() });
    for (const change of [{ backendGeneration: 'other' }, { createdWithVersion: '0.2' }, { createdWithVersion: null },
      { backendGeneration: null }, { createdWithVersion: '01.2.0' }, { extra: true }])
      await denied(first, `rooms/${secret()}`, 'PUT', { metadata: { ...metadata, ...change }, playback: playback() });
    for (const change of [{ createdWithVersion: '0.3.0' }, { backendGeneration: 'other' }])
      await denied(second, `${path}/metadata`, 'PATCH', change);
    await allowed(second, `${path}/playback`, 'PUT', playback(second,
      { revision: 1, videoRevision: 1, kind: 'switch-video', videoId: 'dQw4w9WgXcQ' }));
    expect((await allowed(first, path)).metadata).toEqual(metadata);
  });
  it('требует название актуального формата и запрещает изменение metadata', async () => {
    await denied(first, `rooms/${secret()}`, 'PUT', { playback: playback() });
    for (const metadata of [{}, { name: '' }, { name: '   ' }, { name: 'a'.repeat(201) }, { name: 1 }, { name: 'A', extra: true }]) {
      await denied(first, `rooms/${secret()}`, 'PUT', { metadata, playback: playback() });
    }
    const path = await room();
    expect((await allowed(second, path)).metadata).toEqual({ name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' });
    await denied(first, `${path}/metadata`, 'PUT', { name: 'Rename' });
    await denied(second, `${path}/metadata/name`, 'PUT', 'Rename');
    await denied(first, `${path}/metadata`, 'DELETE');
    await allowed(second, `${path}/playback`, 'PUT', playback(second, { revision: 1 }));
    expect((await allowed(first, path)).metadata).toEqual({ name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' });
  });

  it('без Auth запрещает чтение, создание, playback и presence даже с секретом', async () => {
    const path = await room();
    await denied(null, path);
    await denied(null, `${path}/playback`);
    await denied(null, `rooms/${secret()}`, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback() });
    await denied(null, `${path}/playback`, 'PUT', playback(second, { revision: 1 }));
    await denied(null, `${path}/presence/${first.uid}`, 'PUT', presence());
    await denied(null, path, 'DELETE');
  });

  it('закрывает корень, список и запросы комнат; UID и неполный ключ не дают доступа', async () => {
    const path = await room();
    await denied(first, '');
    await denied(first, 'rooms');
    await denied(first, 'rooms', 'GET', undefined, `orderBy="$key"&equalTo="${path.slice(6)}"`);
    for (const key of ['public-room', second.uid, path.slice(6, 22), 'a'.repeat(129)]) {
      await denied(second, `rooms/${key}`);
      await denied(second, `rooms/${key}`, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(second) });
      await denied(second, `rooms/${key}/playback`, 'PUT', playback(second));
    }
    const absent = `rooms/${secret()}`;
    expect(await allowed(second, absent)).toBeNull();
    await denied(second, `${absent}/playback`, 'PUT', playback(second, { revision: 1 }));
    await denied(second, `${absent}/presence/${second.uid}`, 'PUT', presence());
    expect(await allowed(first, path)).toHaveProperty('playback.actorUid', first.uid);
  });

  it('два UID с полным секретом читают и управляют playback на равных правах', async () => {
    const path = await room();
    const initial = await allowed(second, path);
    expect(initial.playback).toMatchObject({ revision: 0, kind: 'playback' as const, videoRevision: 0, positionSeconds: 12.5, isPlaying: false });
    expect(initial.playback.updatedAt).toEqual(expect.any(Number));
    const next = playback(second, { revision: 1, positionSeconds: 42.25, playbackRate: 1.5, isPlaying: true });
    await allowed(second, `${path}/playback`, 'PUT', next);
    expect((await allowed(first, path)).playback).toMatchObject({ ...next, updatedAt: expect.any(Number) });
    await allowed(first, `${path}/playback`, 'PUT', playback(first, { revision: 2 }));
  });

  it('разрешает свой presence и выход; чужую запись нельзя создавать, менять или удалять', async () => {
    const path = await room();
    const own = `${path}/presence/${first.uid}`;
    const other = `${path}/presence/${second.uid}`;
    await denied(first, other, 'PUT', presence());
    await allowed(first, own, 'PUT', presence());
    await allowed(second, other, 'PUT', presence());
    const original = await allowed(first, `${path}/presence`);
    await denied(first, other, 'PATCH', presence());
    await denied(first, other, 'DELETE');
    await denied(first, `${path}/presence`, 'PUT', { [first.uid]: presence() });
    await denied(first, `${path}/presence`, 'DELETE');
    await denied(first, path, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(first, { revision: 1 }) });
    expect(await allowed(first, `${path}/presence`)).toEqual(original);
    await allowed(first, own, 'DELETE');
    await allowed(second, `${path}/playback`, 'PUT', playback(second, { revision: 1 }));
    expect(await allowed(second, other)).toEqual(original[second.uid]);
    await allowed(second, other, 'DELETE');
    expect((await allowed(second, path)).playback.revision).toBe(1);
  });

  it('атомарно отклоняет попытку скрыть чужой presence в создании или общей записи', async () => {
    await denied(first, `rooms/${secret()}`, 'PUT', {
      metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(), presence: { [second.uid]: presence() },
    });
    const path = await room();
    await allowed(second, `${path}/presence/${second.uid}`, 'PUT', presence());
    const original = await allowed(first, path);
    await denied(first, path, 'PATCH', {
      playback: playback(first, { revision: 1 }), [`presence/${second.uid}`]: null,
    });
    expect(await allowed(first, path)).toEqual(original);
    // Разрешённый multi-location update проверяет права отдельно для каждого пути.
    await allowed(first, path, 'PATCH', {
      playback: playback(first, { revision: 1 }), [`presence/${first.uid}`]: presence(),
    });
  });

  it('несколько соединений UID независимы; серверное время и структура presence проверяются', async () => {
    const path = await room();
    const own = `${path}/presence/${first.uid}/connections`;
    await allowed(first, `${own}/first`, 'PUT', { connectedAt: timestamp });
    await allowed(first, `${own}/second`, 'PUT', { connectedAt: timestamp });
    await denied(second, `${own}/third`, 'PUT', { connectedAt: timestamp });
    await denied(second, `${own}/first`, 'DELETE');
    for (const value of [{ connectedAt: 0 }, { connectedAt: timestamp, extra: true }, { extra: true }, 'online']) {
      await denied(first, `${own}/bad`, 'PUT', value);
    }
    await allowed(first, `${own}/first`, 'DELETE');
    expect(Object.keys(await allowed(first, own))).toEqual(['second']);
    await allowed(first, `${own}/second`, 'DELETE');
    expect(await allowed(first, `${path}/presence`)).toBeNull();
    await allowed(second, `${path}/playback`, 'PUT', playback(second, { revision: 1 }));
  });

  it.each([
    ['отрицательная позиция', { positionSeconds: -1 }],
    ['строковая позиция', { positionSeconds: '12' }],
    ['слишком большая позиция', { positionSeconds: 1e20 }],
    ['нулевая скорость', { playbackRate: 0 }],
    ['отрицательная скорость', { playbackRate: -1 }],
    ['слишком большая скорость', { playbackRate: 17 }],
    ['строковая скорость', { playbackRate: '1' }],
    ['не boolean', { isPlaying: 'true' }],
    ['неверный videoId', { videoId: 'bad/video' }],
    ['пустой commandId', { commandId: '' }],
    ['длинный commandId', { commandId: 'a'.repeat(129) }],
    ['числовой commandId', { commandId: 1 }],
    ['чужой actorUid', { actorUid: 'another-uid' }],
    ['несерверное время', { updatedAt: 0 }],
    ['будущее время', { updatedAt: 9e15 }],
    ['будущее действие', { actionAt: 9e15, sampledAt: 9e15 }],
    ['отрицательное действие', { actionAt: -1 }],
    ['строковое действие', { actionAt: '123' }],
    ['позиция раньше действия', { actionAt: 100, sampledAt: 99 }],
    ['будущее считывание', { sampledAt: 9e15 }],
    ['отрицательная revision', { revision: -1 }],
    ['дробная revision', { revision: 0.5 }],
    ['пропущенная revision', { revision: 2 }],
    ['небезопасная revision', { revision: 1e20 }],
    ['личная громкость', { volume: 0.5 }],
    ['личное качество', { quality: 'hd1080' }],
    ['личные субтитры', { subtitles: true }],
  ])('отклоняет некорректный playback: %s', async (_name, changes) => {
    await denied(first, `rooms/${secret()}`, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(first, changes) });
    const path = await room();
    const original = await allowed(first, path);
    await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 1, ...changes }));
    expect(await allowed(first, path)).toEqual(original);
  });

  it('не допускает удаления обязательных полей, playback, комнаты и произвольных данных', async () => {
    const path = await room();
    const original = await allowed(first, path);
    for (const field of Object.keys(playback())) {
      await denied(first, `rooms/${secret()}`, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(first, { [field]: null }) });
      await denied(first, `${path}/playback`, 'PATCH', {
        revision: 1, commandId: randomUUID(), updatedAt: timestamp, [field]: null,
      });
    }
    for (const target of [path, `${path}/playback`]) await denied(first, target, 'DELETE');
    await denied(first, `${path}/extra`, 'PUT', true);
    await denied(first, `rooms/${secret()}`, 'PUT', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: playback(), extra: true });
    await denied(first, `rooms/${secret()}`, 'PUT', { presence: { [first.uid]: presence() } });
    await denied(first, `${path}/presence/${first.uid}`, 'PUT', { connectedAt: timestamp, extra: true });
    await denied(first, `${path}/presence/${first.uid}`, 'PUT', { connectedAt: 0 });
    await denied(first, `${path}/presence/${first.uid}`, 'PUT', 'online');
    expect(await allowed(first, path)).toEqual(original);
  });

  it('отклоняет stale/replayed revision, повтор commandId и замену общего videoId', async () => {
    const path = await room();
    const next = playback(second, { revision: 1 });
    await allowed(second, `${path}/playback`, 'PUT', next);
    const original = await allowed(first, path);
    await denied(second, `${path}/playback`, 'PUT', next);
    await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 0 }));
    await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 3 }));
    await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 2, commandId: next.commandId }));
    await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 2, videoId: 'dQw4w9WgXcQ' }));
    expect(await allowed(first, path)).toEqual(original);
  });

  it('требует обе метки при создании и запрещает откат actionAt с правильной следующей revision', async () => {
    const { actionAt, sampledAt, ...incomplete } = playback(first);
    await denied(first, `rooms/${secret()}`, 'PUT', { playback: incomplete });
    const path = await room();
    const next = playback(second, { revision: 1 });
    await allowed(second, `${path}/playback`, 'PUT', next);
    for (const patch of [
      { actionAt: next.actionAt - 1 }, { actionAt: next.actionAt },
      { actionAt: null, sampledAt: null }, { actionAt: null }, { sampledAt: null },
    ]) await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 2, ...patch }));
    expect((await allowed(first, path)).playback.commandId).toBe(next.commandId);
  });
});

it('смена видео атомарна и требует нового поколения; обычная команда не меняет videoId', async () => {
  const path = await room();
  for (const changes of [
    { kind: 'switch-video', videoId: 'dQw4w9WgXcQ', videoRevision: 0 },
    { kind: 'playback', videoId: 'dQw4w9WgXcQ', videoRevision: 1 },
    { kind: 'switch-video', videoId: 'aqz-KE-bpKQ', videoRevision: 1 },
    { kind: 'other', videoRevision: 1 }, { videoRevision: -1 }, { videoRevision: 0.5 },
  ]) await denied(second, `${path}/playback`, 'PUT', playback(second, { revision: 1, ...changes }));
  await allowed(second, `${path}/playback`, 'PUT', playback(second,
    { kind: 'switch-video', videoId: 'dQw4w9WgXcQ', videoRevision: 1, revision: 1 }));
  await allowed(first, `${path}/playback`, 'PUT', playback(first,
    { kind: 'switch-video', videoRevision: 2, revision: 2 }));
  // Совпадающий videoId после возврата не разрешает старое поколение.
  await denied(first, `${path}/playback`, 'PUT', playback(first, { revision: 3, videoRevision: 0 }));
  await allowed(first, `${path}/playback`, 'PUT', playback(first, { revision: 3, videoRevision: 2 }));
  expect((await allowed(first, path)).metadata).toEqual({ name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' });
  for (const missing of ['kind', 'videoRevision']) {
    const value = playback(); delete value[missing as keyof typeof value];
    await denied(first, `rooms/${secret()}`, 'PUT', { metadata: { name: 'Old', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: value });
  }
});
