import { goOffline, goOnline, onValue, ref, serverTimestamp, set, type Unsubscribe } from 'firebase/database';
import { closeFirebaseClient, getFirebaseClient } from '../firebase/client';
import { firebaseConfig } from '../firebase/config';
import { abortable } from '../service-status';
import { createConnectionAttempt, type AttemptState } from '../connection-attempt';
import { classifyFailure, ConnectionError, failureMessage, statusFailure } from '../connection-error';
import { roomKeySchema } from './key';
import { generateRoomKey, initialPlaybackSchema, invitationUrl, type InitialPlayback } from './creation';
import { invitationRoomSchema } from './invitation';
import { createPresence, roomParticipants, type Participant } from './presence';
import { submitPlaybackCommand } from './commands';
import { type PlaybackCommand, type CommandResult } from '../playback/commands';
import { roomMetadataSchema, type RoomMetadata } from './metadata';
import { createGenerationAvailability } from '../generation-availability';

export interface TransportState {
  phase: 'idle' | 'authenticating' | 'ready' | 'error' | 'closed';
  uid: string | null; connected: boolean; roomReady: boolean; serverTimeOffset: number;
  room: unknown; roomError: string | null; error: string | null; invitation: string | null;
  creating: boolean; creationError: string | null; participants: Participant[]; presenceError: string | null;
  recovery?: AttemptState;
}

/** Только watch-документ владеет этим realtime-соединением. */
export function createRoomTransport(onChange: (state: TransportState) => void, options: { presence?: boolean } = {}) {
  const state: TransportState = {
    phase: 'idle', uid: null, connected: false, roomReady: false, serverTimeOffset: 0,
    room: null, roomError: null, error: null, invitation: null, creating: false, creationError: null,
    participants: [], presenceError: null,
  };
  const config = firebaseConfig();
  const service = config ? createGenerationAvailability(config) : null;
  let disposed = false;
  let preserveHealthy = false;
  let client: Awaited<ReturnType<typeof getFirebaseClient>> | undefined;
  let subscriptions: Unsubscribe[] = [];
  let roomSubscription: Unsubscribe | undefined;
  let roomKey: string | null = null;
  let roomGeneration = 0, connectionGeneration = 0;
  let presence: ReturnType<typeof createPresence> | undefined;
  let commands = new AbortController();
  let connectedWaiter: (() => void) | undefined;
  let readOperation: AbortController | undefined;
  let creating: Promise<void> | undefined;
  let pendingCreation: { key: string; playback: InitialPlayback; metadata: RoomMetadata; attempted: boolean } | undefined;
  const status = () => structuredClone(state);
  const emit = () => { if (!disposed) onChange(status()); };
  function blockSync() {
    commands.abort(); commands = new AbortController(); readOperation?.abort();
    presence?.close(); presence = undefined;
    connectionGeneration++; state.roomReady = false;
  }
  function acceptRoom(room: unknown, fromReader = false) {
    const current = invitationRoomSchema.safeParse(state.room), incoming = invitationRoomSchema.safeParse(room);
    state.room = current.success && incoming.success
      ? { ...((fromReader ? state.room : room) as Record<string, unknown>),
        playback: current.data.playback.revision > incoming.data.playback.revision ? current.data.playback : incoming.data.playback }
      : room;
    state.roomError = room === null ? 'Комната не найдена.'
      : !incoming.success ? 'Формат комнаты не поддерживается. Создайте новую комнату.' : null;
    if (state.roomError) { state.roomReady = false; presence?.close(); presence = undefined; }
    state.participants = incoming.success ? roomParticipants((state.room as { presence?: unknown })?.presence, state.uid!) : [];
  }
  function startPresence() {
    if (!client || !roomKey || !state.roomReady || options.presence === false || presence) return;
    const generation = roomGeneration;
    presence = createPresence(client.database, roomKey, client.uid, () => {
      if (disposed || generation !== roomGeneration) return;
      state.presenceError = 'Не удалось обновить присутствие. Повторите подключение.'; emit();
    });
    presence.setConnected(state.connected);
  }
  function subscribeRoom() {
    if (!client || !roomKey || roomSubscription) return;
    const generation = roomGeneration, key = roomKey;
    const { database } = client;
    roomSubscription = onValue(ref(database, `rooms/${key}`), snapshot => {
      if (disposed || generation !== roomGeneration) return;
      const previousError = state.roomError;
      acceptRoom(snapshot.val());
      if (!state.roomReady && previousError && !state.roomError) state.roomError = previousError;
      emit();
    }, error => {
      if (disposed || generation !== roomGeneration) return;
      blockSync(); state.participants = [];
      state.roomError = failureMessage(classifyFailure(error)); emit();
    });
  }
  const attempt = createConnectionAttempt({
    status: signal => {
      if (preserveHealthy) { preserveHealthy = false; return Promise.resolve({ state: 'unknown' }); }
      return service?.read(signal) ?? Promise.resolve({ state: 'unknown' });
    },
    suspend() { blockSync(); state.connected = false; if (client) goOffline(client.database); },
    change(recovery) {
      state.recovery = recovery;
      if (recovery.failure) {
        state.error = failureMessage(recovery.failure);
        if (roomKey) state.roomError = state.error;
      } else state.error = null;
      if (recovery.phase === 'running') { state.phase = 'authenticating'; state.roomError = null; }
      if (recovery.phase === 'failed' || recovery.phase === 'waiting' || recovery.phase === 'stopped') state.phase = 'error';
      if (recovery.phase === 'succeeded') { state.phase = 'ready'; state.error = null; state.presenceError = null; }
      emit();
    },
    async run(signal) {
      const generation = roomGeneration;
      client = await abortable(getFirebaseClient(), signal);
      signal.throwIfAborted();
      if (disposed || generation !== roomGeneration) throw new DOMException('Cancelled', 'AbortError');
      state.uid = client.uid;
      if (!subscriptions.length) {
        subscriptions.push(onValue(ref(client.database, '.info/connected'), snapshot => {
          if (disposed) return;
          const wasConnected = state.connected;
          const online = snapshot.val() === true;
          if (online && !['running', 'succeeded'].includes(attempt.snapshot().phase)) return;
          state.connected = online;
          if (!state.connected) {
            blockSync(); state.presenceError = null;
            // SDK reconnect работает внутри этой попытки. После deadline его
            // соединение приостановит владелец; параллельного цикла нет.
            if (wasConnected && attempt.snapshot().phase === 'succeeded') void attempt.restart();
          } else connectedWaiter?.();
          presence?.setConnected(state.connected); emit();
        }));
        subscriptions.push(onValue(ref(client.database, '.info/serverTimeOffset'), snapshot => {
          const offset: unknown = snapshot.val();
          state.serverTimeOffset = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0; emit();
        }));
      }
      goOnline(client.database);
      subscribeRoom();
      while (true) {
        if (!state.connected) {
          try { await abortable(new Promise<void>(resolve => { connectedWaiter = resolve; }), signal); }
          finally { connectedWaiter = undefined; }
        }
        signal.throwIfAborted();
        if (!roomKey) return;
        const connection = connectionGeneration;
        const reader = new AbortController(); readOperation = reader;
        try {
          const room = await abortable(client.readRoom(roomKey, AbortSignal.any([signal, reader.signal])), AbortSignal.any([signal, reader.signal]));
          signal.throwIfAborted();
          if (disposed || generation !== roomGeneration) throw new DOMException('Cancelled', 'AbortError');
          if (connection !== connectionGeneration || !state.connected) continue;
          acceptRoom(room, true);
          if (room === null) throw new ConnectionError('not-found');
          if (!invitationRoomSchema.safeParse(room).success) throw new ConnectionError('unsupported-room');
          state.roomReady = true;
          startPresence();
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (reader.signal.aborted && connection !== connectionGeneration) continue;
          throw error;
        } finally { if (readOperation === reader) readOperation = undefined; }
      }
    },
  });
  function unwatchRoom() {
    roomGeneration++; attempt.dispose(); blockSync(); roomKey = null;
    presence?.close(); presence = undefined; roomSubscription?.(); roomSubscription = undefined;
    state.room = null; state.roomError = null; state.invitation = null; state.participants = []; state.presenceError = null;
    state.error = null; state.recovery = undefined; emit();
  }
  async function watchRoom(key: string) {
    const secret = roomKeySchema.parse(key);
    unwatchRoom(); preserveHealthy = false; roomKey = secret;
    await attempt.restart();
  }
  return {
    status,
    start() { if (disposed || state.phase === 'ready') return Promise.resolve(); return attempt.restart(); },
    watchRoom,
    refresh() { if (disposed || !roomKey) return Promise.resolve(); preserveHealthy = state.connected && state.roomReady; blockSync(); return attempt.restart(); },
    stop() { attempt.stop(); },
    async sendCommand(command: PlaybackCommand): Promise<CommandResult> {
      if (disposed || state.phase !== 'ready' || !roomKey || !client) return { status: 'rejected', reason: 'inactive', playback: null };
      const generation = roomGeneration, connection = connectionGeneration, signal = commands.signal;
      return submitPlaybackCommand(client.database, roomKey, client.uid, command, () => {
        if (disposed || generation !== roomGeneration) return 'inactive';
        return state.connected && state.roomReady && connection === connectionGeneration ? null : 'offline';
      }, signal);
    },
    async retry() {
      if (disposed) return;
      preserveHealthy = state.connected && state.roomReady;
      blockSync();
      await attempt.restart();
      if (state.connected) presence?.retry(true);
    },
    async createRoom(input: InitialPlayback, inputMetadata: RoomMetadata) {
      const playback = initialPlaybackSchema.parse(input), metadata = roomMetadataSchema.parse(inputMetadata);
      if (creating) return creating;
      if (disposed || state.invitation) return;
      state.creationError = null;
      if (!client || state.phase !== 'ready' || !state.connected) {
        state.creationError = 'Нет связи с сервером. Дождитесь подключения и повторите попытку.'; emit(); return;
      }
      state.creating = true; emit();
      creating = (async () => {
        const signal = AbortSignal.timeout(15_000);
        try {
          const announced = statusFailure(await abortable(service?.read(signal) ?? Promise.resolve({ state: 'unknown' as const }), signal));
          if (announced) throw Object.assign(new Error(), { failure: announced });
          if (disposed) return;
          pendingCreation ??= { key: generateRoomKey(), playback, metadata, attempted: false };
          const pending = pendingCreation;
          // Потерянный ack: перед явным повтором проверяем тот же ключ.
          // Если результата пока нет, ключ сохраняется; новый не создаём.
          if (pending.attempted) {
            const room = await client!.readRoom(pending.key, signal);
            if (room === null) throw new Error('creation/uncertain');
            if (!invitationRoomSchema.safeParse(room).success) throw new ConnectionError('unsupported-room');
          } else {
            pending.attempted = true;
            await abortable(set(ref(client!.database, `rooms/${pending.key}`), { metadata: pending.metadata, playback: {
              ...pending.playback, revision: 0, videoRevision: 0, kind: 'playback', actorUid: client!.uid,
              commandId: crypto.randomUUID(), updatedAt: serverTimestamp(), actionAt: serverTimestamp(), sampledAt: serverTimestamp(),
            } }), signal);
          }
          if (disposed) return;
          await watchRoom(pending.key);
          if (!disposed && state.roomReady) {
            state.invitation = invitationUrl(config!.invitationBaseUrl, pending.key); pendingCreation = undefined;
          } else throw new Error('creation/uncertain');
        } catch (error) {
          if (classifyFailure(error).kind === 'access-denied') pendingCreation = undefined;
          state.creationError = pendingCreation?.attempted
            ? 'Результат создания пока неизвестен. Повторите проверку: новая комната не будет создана.'
            : 'Не удалось создать комнату. ' + failureMessage(classifyFailure(error));
          if (error && typeof error === 'object' && 'failure' in error) state.creationError = failureMessage((error as ConnectionError).failure);
        } finally { state.creating = false; creating = undefined; emit(); }
      })();
      return creating;
    },
    unwatchRoom,
    async close() {
      if (disposed) return;
      disposed = true; unwatchRoom(); for (const unsubscribe of subscriptions) unsubscribe(); subscriptions = [];
      if (client) goOffline(client.database);
      await closeFirebaseClient(); state.phase = 'closed'; state.connected = false; state.uid = null;
    },
  };
}
