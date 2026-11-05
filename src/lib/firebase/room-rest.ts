import type { FirebaseConfig } from './settings';
import { roomKeySchema } from '../room/key';
import { abortable } from '../service-status';
import { classifyFailure, ConnectionError } from '../connection-error';

export async function readRoomRest(config: FirebaseConfig, key: string, token: () => Promise<string>, signal: AbortSignal, request: typeof fetch = fetch): Promise<unknown> {
  const secret = roomKeySchema.parse(key);
  signal.throwIfAborted();
  let idToken: string;
  try { idToken = await abortable(token(), signal); }
  catch (error) { throw new ConnectionError(classifyFailure(error, 'auth').kind, 'auth'); }
  signal.throwIfAborted();
  const url = new URL(`/rooms/${secret}.json`, config.emulators ? 'http://127.0.0.1:9000' : config.databaseURL);
  if (config.emulators) url.searchParams.set('ns', new URL(config.databaseURL).hostname.split('.')[0]!);
  url.searchParams.set('auth', idToken);
  try {
    const response = await abortable(request(url.href, {
      signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    }), signal);
    // 401/403 не доказывают квоту. Firebase REST возвращает Permission denied
    // также при истёкшем/невалидном token; тело ошибки не выносим наружу.
    if (!response.ok) throw new ConnectionError(response.status === 401 || response.status === 403 ? 'access-denied' : 'network-or-timeout');
    return await abortable(response.json(), signal);
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError('network-or-timeout');
  }
}
