import { onDisconnect, ref, remove, serverTimestamp, set, type Database } from 'firebase/database';
import { z } from 'zod';

const presenceSchema = z.record(z.string(), z.object({
  connections: z.record(z.string(), z.object({ connectedAt: z.number().finite().nonnegative() }).strict()),
}).strict());

export interface Participant {
  number: number;
  color: string;
  isSelf: boolean;
}

/** Одинаковый порядок во всех клиентах, без публикации UID в UI. */
export function roomParticipants(value: unknown, ownUid: string | null): Participant[] {
  const parsed = presenceSchema.safeParse(value);
  if (!parsed.success) return [];
  return Object.keys(parsed.data).filter(uid => Object.keys(parsed.data[uid]!.connections).length > 0)
    .sort().map((uid, index) => ({
      number: index + 1, color: `hsl(${(index * 137.508) % 360} 70% 65%)`, isSelf: uid === ownUid,
    }));
}

/** Один lease на соединение документа. При reconnect onDisconnect регистрируется заново. */
export function createPresence(database: Database, key: string, uid: string, onError: () => void) {
  let closed = false;
  let failed = false;
  let lease: ReturnType<typeof connect> | undefined;

  function connect() {
    // Новый путь защищает другие документы того же UID и следующее соединение.
    const connection = ref(database, `rooms/${key}/presence/${uid}/connections/${crypto.randomUUID()}`);
    const disconnect = onDisconnect(connection);
    let active = true;
    const registration = (async () => {
      try {
        // Сначала сервер подтверждает уборку, только затем публикуем присутствие.
        await disconnect.remove();
        if (!active || closed) return;
        await set(connection, { connectedAt: serverTimestamp() });
      } catch {
        if (active && !closed) { failed = true; onError(); }
      }
    })();
    return {
      release() {
        active = false;
        // remove ставится в очередь после уже начатого set, в том числе offline.
        // onDisconnect остаётся активным до подтверждения удаления.
        void remove(connection).then(async () => {
          await registration;
          await disconnect.cancel();
        }).catch(() => { /* Закрытие сокета оставляет серверную уборку активной. */ });
      },
    };
  }

  return {
    setConnected(online: boolean) {
      if (closed) return;
      if (!online) {
        lease?.release();
        lease = undefined;
        failed = false;
      } else if (!lease && !failed) lease = connect();
    },
    retry(online: boolean) {
      lease?.release();
      lease = undefined;
      failed = false;
      if (!closed && online) lease = connect();
    },
    close() {
      closed = true;
      lease?.release();
      lease = undefined;
    },
  };
}
