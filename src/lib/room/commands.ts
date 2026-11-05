import { onValue, ref, runTransaction, serverTimestamp, type Database } from 'firebase/database';
import { playbackSchema } from '../playback/model';
import { playbackCommandSchema, preparePlaybackCommand, type PlaybackCommand, type CommandResult } from '../playback/commands';
import { roomKeySchema } from './key';

// Скрытые optimistic-записи SDK тоже видны другим транзакциям того же клиента.
// До server ack новая операция на этом пути отклоняется, а не подтверждается по локальной записи.
const pending = new WeakMap<Database, Set<string>>();

export async function submitPlaybackCommand(
  database: Database, key: string, actorUid: string, input: PlaybackCommand,
  canWrite: () => 'offline' | 'inactive' | null = () => null,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const secret = roomKeySchema.parse(key);
  const command = playbackCommandSchema.parse(input);
  playbackSchema.shape.actorUid.parse(actorUid);
  const blocked = canWrite() ?? (signal?.aborted ? 'offline' : null);
  if (blocked) return { status: 'rejected', reason: blocked, playback: null };
  const playbackRef = ref(database, `rooms/${secret}/playback`);
  const paths = pending.get(database) ?? new Set<string>();
  pending.set(database, paths);
  if (paths.has(secret)) return { status: 'rejected', reason: 'busy', playback: null };
  paths.add(secret);
  let unsubscribe = () => {};
  let onAbort = () => {};
  try {
    // У runTransaction первый currentData может быть null из пустого cache.
    // Держим подписку до завершения: одноразовый get не сохраняет cache SDK.
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new Error('Playback command cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      signal?.throwIfAborted();
      unsubscribe = onValue(playbackRef, () => resolve(), reject);
    });
    let stopped: 'offline' | 'inactive' | null = null;
    const result = await runTransaction(playbackRef, (value: unknown) => {
      stopped = canWrite() ?? (signal?.aborted ? 'offline' : null);
      if (stopped) return;
      const decision = preparePlaybackCommand(value, command, actorUid);
      if (decision.status === 'write') return { ...decision.playback, updatedAt: serverTimestamp() };
      return;
    }, { applyLocally: false });
    if (result.committed) return { status: 'committed', playback: playbackSchema.parse(result.snapshot.val()) };
    if (stopped) {
      const parsed = playbackSchema.safeParse(result.snapshot.val());
      return { status: 'rejected', reason: stopped, playback: parsed.success ? parsed.data : null };
    }
    const decision = preparePlaybackCommand(result.snapshot.val(), command, actorUid);
    if (decision.status === 'write') throw new Error('Unexpected aborted playback transaction');
    return decision;
  } catch (error) {
    const reason = canWrite() ?? (signal?.aborted ? 'offline' : null);
    if (reason) return { status: 'rejected', reason, playback: null };
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    paths.delete(secret);
  }
}
