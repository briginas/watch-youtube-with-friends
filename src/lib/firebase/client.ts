import { t } from '../i18n';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, signInAnonymously,
} from 'firebase/auth/web-extension';
import { connectDatabaseEmulator, forceWebSockets, getDatabase, goOffline } from 'firebase/database';
import { firebaseConfig } from './config';
import { readRoomRest } from './room-rest';
import { classifyFailure, failureMessage } from '../connection-error';

forceWebSockets();

async function initializeClient() {
  const config = firebaseConfig();
  if (!config) throw new Error('firebase/not-configured');
  // Lock включает создание Auth, hydration IndexedDB и первый sign-in.
  // Иначе одновременно открытые документы могут создать разные Anonymous UID.
  return navigator.locks.request('watch-together-anonymous-auth', async () => {
    const app = initializeApp(config, 'watch-together');
    try {
      const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
      if (import.meta.env.WXT_RELEASE !== '1' && config.emulators) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      await auth.authStateReady();
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
      const database = getDatabase(app);
      if (import.meta.env.WXT_RELEASE !== '1' && config.emulators) connectDatabaseEmulator(database, '127.0.0.1', 9000);
      return { uid: user.uid, database,
        readRoom(key: string, signal: AbortSignal): Promise<unknown> {
          return readRoomRest(config, key, () => user.getIdToken(), signal);
        }, async close() {
        goOffline(database);
        await deleteApp(app);
      } };
    } catch (error) {
      await deleteApp(app);
      throw error;
    }
  });
}

let client: ReturnType<typeof initializeClient> | undefined;

export function getFirebaseClient() {
  client ??= initializeClient().catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
}

/** Вызывается владельцем документа, после снятия всех его подписок. */
export async function closeFirebaseClient() {
  const current = client;
  if (!current) return;
  if (client === current) client = undefined;
  // Не блокируем закрытие документа зависшим Auth. Поздний ресурс закроется.
  void current.then(value => value.close()).catch(() => {});
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'firebase/not-configured') {
    return t('serverNotConfigured');
  }
  return failureMessage(classifyFailure(error, 'auth'));
}
