import { getFirebaseClient } from '../firebase/client';
import { firebaseConfig } from '../firebase/config';
import { abortable } from '../service-status';
import { createConnectionAttempt, type AttemptState } from '../connection-attempt';
import { ConnectionError } from '../connection-error';
import { createGenerationAvailability } from '../generation-availability';
import { invitationRoomSchema } from './invitation';
import type { z } from 'zod';

// Shared на документ, в том числе между строками каталога.
let service: ReturnType<typeof createGenerationAvailability> | undefined;
export function createReadOnlyEntry(options: {
  key: string; backendGeneration?: string; change: (state: AttemptState) => void;
  activate: (signal: AbortSignal) => Promise<boolean>;
  open: (room: z.infer<typeof invitationRoomSchema>, signal: AbortSignal) => Promise<void>;
}) {
  const config = firebaseConfig();
  if (config) service ??= createGenerationAvailability(config);
  let activated = false;
  return createConnectionAttempt({
    change: options.change,
    // Локальная активация выполняется раньше статуса/Auth/REST.
    async status(signal) {
      if (config && options.backendGeneration && options.backendGeneration !== config.backendGeneration)
        return await service!.read(signal, options.backendGeneration);
      activated = await abortable(options.activate(signal), signal);
      signal.throwIfAborted();
      return activated ? { state: 'unknown' } : await service?.read(signal) ?? { state: 'unknown' };
    },
    async run(signal) {
      if (activated) return;
      const client = await abortable(getFirebaseClient(), signal);
      signal.throwIfAborted();
      const value = await abortable(client.readRoom(options.key, signal), signal);
      signal.throwIfAborted();
      if (value === null) throw new ConnectionError('not-found');
      const room = invitationRoomSchema.safeParse(value);
      if (!room.success) throw new ConnectionError('unsupported-room');
      await abortable(options.open(room.data, signal), signal);
      signal.throwIfAborted();
    },
  });
}
