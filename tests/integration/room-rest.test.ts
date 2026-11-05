import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { expect, it } from 'vitest';
import { readRoomRest } from '../../src/lib/firebase/room-rest';
import { invitationRoomSchema } from '../../src/lib/room/invitation';
const config = { apiKey: 'demo-key-not-a-production-credential', projectId: 'demo-watch-together', databaseURL: 'https://demo-watch-together-default-rtdb.firebaseio.com', invitationBaseUrl: 'http://127.0.0.1:5002/', emulators: true, backendGeneration: 'emulator-v1', controlProjectId: 'demo-watch-together' };
it('REST применяет настоящие Auth/Rules с тем же UID, null/format/list отказ; Hosting JSON headers', async () => {
  const app = initializeApp(config, crypto.randomUUID());
  try {
    const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    const { user } = await signInAnonymously(auth);
    const token = await user.getIdToken();
    const key = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const base = 'http://127.0.0.1:9000'; const ns = 'demo-watch-together-default-rtdb';
    const url = `${base}/rooms/${key}.json?ns=${ns}`;
    expect((await fetch(url)).ok).toBe(false);
    expect((await fetch(`${base}/rooms.json?ns=${ns}&auth=${token}`)).ok).toBe(false);
    expect(await readRoomRest(config, key, () => user.getIdToken(), AbortSignal.timeout(10_000))).toBeNull();
    const fixture = { metadata: { name: 'REST', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', isPlaying: false, playbackRate: 1, positionSeconds: 0, revision: 0, videoRevision: 0, kind: 'playback', actorUid: user.uid, commandId: crypto.randomUUID(), actionAt: Date.now(), sampledAt: Date.now(), updatedAt: { '.sv': 'timestamp' } } };
    const write = await fetch(`${url}&auth=${token}`, { method: 'PUT', body: JSON.stringify(fixture) }); expect(write.ok).toBe(true);
    const read = await readRoomRest(config, key, () => user.getIdToken(), AbortSignal.timeout(10_000));
    expect(invitationRoomSchema.parse(read).playback.actorUid).toBe(user.uid);
    const headers = { Authorization: 'Bearer owner' };
    await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ oldFormat: true }) });
    expect(invitationRoomSchema.safeParse(await readRoomRest(config, key, () => user.getIdToken(), AbortSignal.timeout(10_000))).success).toBe(false);
    await fetch(url, { method: 'DELETE', headers });
    const status = await fetch('http://127.0.0.1:5002/service-status.json');
    expect(status.ok).toBe(true); expect(status.headers.get('cache-control')).toBe('no-store');
    expect(status.headers.get('content-type')).toContain('application/json'); expect((await status.json()).version).toBe(1);
  } finally { await deleteApp(app); }
});
