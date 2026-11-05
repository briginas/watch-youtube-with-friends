// Только локальный эксперимент 1.3; этот srcDir не входит в обычную сборку.
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
  signInAnonymously,
} from 'firebase/auth/web-extension';
import {
  connectDatabaseEmulator, forceWebSockets, getDatabase, goOffline, onValue, ref, set,
} from 'firebase/database';

// Long polling загружает JSONP script с сервера и несовместим с MV3 script-src self.
// Вызывается до первого ref/onValue; работает и после прежней ошибки WebSocket.
forceWebSockets();

export interface ProbeState {
  instance: string;
  uid: string | null;
  connected: boolean;
  values: Record<string, { value: string }>;
  events: number;
  error: string | null;
  cspViolations: string[];
}

export function createProbe() {
  const state: ProbeState = {
    instance: crypto.randomUUID(), uid: null, connected: false,
    values: {}, events: 0, error: null, cspViolations: [],
  };
  addEventListener('securitypolicyviolation', (event) => {
    state.cspViolations.push((event as SecurityPolicyViolationEvent).effectiveDirective);
  });
  let cleanup: (() => Promise<void>) | undefined;
  let write: ((value: string) => Promise<void>) | undefined;
  let starting: Promise<ProbeState> | undefined;
  const status = (): ProbeState => structuredClone(state);

  return {
    status,
    start(probeId: string) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(probeId)) throw new Error('Invalid local probe id');
      starting ??= (async () => {
        // Один origin, app name и apiKey: общий IndexedDB Auth во всех контекстах.
        // Lock охватывает и создание Auth, и hydration: второй клиент не читает
        // пустой persistence до завершения первого Anonymous Auth.
        const { app, uid } = await navigator.locks.request('firebase-probe-anonymous-auth', async () => {
          const app = initializeApp({
            projectId: 'demo-watch-together',
            apiKey: 'demo-key-not-a-production-credential',
            databaseURL: 'https://demo-watch-together-default-rtdb.firebaseio.com',
          });
          try {
            const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
            connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
            await auth.authStateReady();
            const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
            return { app, uid: user.uid };
          } catch (error) {
            await deleteApp(app);
            throw error;
          }
        });
        state.uid = uid;
        const database = getDatabase(app);
        connectDatabaseEmulator(database, '127.0.0.1', 9000);
        const fail = (error: Error) => { state.error = error.message; };
        let unsubscribe = () => {};
        const initialSnapshot = new Promise<void>((resolveSnapshot, rejectSnapshot) => {
          unsubscribe = onValue(ref(database, `_probes/${probeId}`), (snapshot) => {
            state.values = snapshot.val() ?? {};
            state.events++;
            resolveSnapshot();
          }, (error) => {
            fail(error);
            rejectSnapshot(error);
          });
        });
        const connected = onValue(ref(database, '.info/connected'), (snapshot) => {
          state.connected = snapshot.val() === true;
        }, fail);
        write = async (value) => {
          if (value.length > 100) throw new Error('Probe value too long');
          await set(ref(database, `_probes/${probeId}/${uid}`), { value });
        };
        cleanup = async () => {
          unsubscribe();
          connected();
          goOffline(database);
          await deleteApp(app);
          state.connected = false;
        };
        try {
          await initialSnapshot;
        } catch (error) {
          await cleanup();
          throw error;
        }
        return status();
      })();
      return starting;
    },
    async write(value: string) {
      await starting;
      if (!write) throw new Error('Start the probe first');
      await write(value);
      return status();
    },
    async stop() { await cleanup?.(); },
  };
}

export type Probe = ReturnType<typeof createProbe>;

declare global {
  // Доступен лишь из DevTools/Playwright в экспериментальной сборке.
  var firebaseProbe: Probe;
  var openProbePopup: (probeId: string) => Promise<ProbeState>;
  var closeProbePopup: () => Promise<void>;
  var probePopupCount: () => Promise<number>;
}
