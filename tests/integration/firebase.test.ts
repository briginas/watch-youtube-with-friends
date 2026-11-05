import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, goOffline, onValue, ref, set } from 'firebase/database';
import { expect, it } from 'vitest';

it('два анонимных клиента с разными UID обмениваются обновлениями через локальную RTDB', async () => {
  // Тест должен запускаться только дочерним процессом emulators:exec.
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
  expect(process.env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  const apps: FirebaseApp[] = [];
  const unsubscribes: (() => void)[] = [];

  try {
    const clients = await Promise.all([0, 1].map(async () => {
      const app = initializeApp({
        projectId: 'demo-watch-together',
        apiKey: 'demo-key-not-a-production-credential',
        databaseURL: 'https://demo-watch-together-default-rtdb.firebaseio.com',
      }, randomUUID());
      apps.push(app);
      const auth = getAuth(app);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      const database = getDatabase(app);
      connectDatabaseEmulator(database, '127.0.0.1', 9000);
      const { user } = await signInAnonymously(auth);
      return { database, uid: user.uid };
    }));
    const first = clients[0]!;
    const second = clients[1]!;
    expect(first.uid).not.toBe(second.uid);

    const probe = `_probes/${randomUUID()}`;
    for (const [writer, reader] of [[first, second], [second, first]] as const) {
      const path = `${probe}/${writer.uid}`;
      const value = randomUUID();
      const received = new Promise<void>((resolveValue, reject) => {
        unsubscribes.push(onValue(ref(reader.database, path), (snapshot) => {
          if (snapshot.val()?.value === value) resolveValue();
        }, reject));
      });
      await set(ref(writer.database, path), { value });
      await received;
    }

    const response = await fetch('http://127.0.0.1:5002');
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('Установите расширение');
  } finally {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    apps.forEach((app) => goOffline(getDatabase(app)));
    await Promise.all(apps.map((app) => deleteApp(app)));
  }
});
