import { z } from 'zod';

const times = {
  version: z.literal(1), updatedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
};
export const serviceStatusSchema = z.discriminatedUnion('state', [
  z.object({ ...times, state: z.literal('operational') }).strict(),
  z.object({ ...times, state: z.literal('busy'), retryAfterSeconds: z.number().int().min(10).max(300).optional() }).strict(),
  z.object({ ...times, state: z.literal('unavailable'), reason: z.enum(['maintenance', 'quota']) }).strict(),
]);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceResult = ServiceStatus | { state: 'unknown' };
export function parseServiceStatus(value: unknown, now = Date.now()): ServiceResult {
  const parsed = serviceStatusSchema.safeParse(value);
  if (!parsed.success) return { state: 'unknown' };
  const status = parsed.data;
  const updated = Date.parse(status.updatedAt), expires = Date.parse(status.expiresAt);
  return updated > now + 300_000 || expires <= now || expires <= updated || expires - updated > 86_400_000
    ? { state: 'unknown' } : status;
}

/** Один экземпляр на документ. Нет polling; ошибки также ограничены по частоте. */
export function createServiceStatusReader(base: string, request: typeof fetch = fetch, generation = 'emulator-v1') {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(generation)) throw new Error('Invalid generation');
  const url = new URL(`/generations/${generation}/service-status.json`, base).href;
  let started = -Infinity;
  let result: ServiceResult = { state: 'unknown' };
  let pending: Promise<ServiceResult> | undefined;
  function cached(): ServiceResult {
    return Date.now() - started < 60_000 && result.state !== 'unknown'
      ? parseServiceStatus(result) : { state: 'unknown' };
  }
  return {
    peek: cached,
    async read(signal?: AbortSignal): Promise<ServiceResult> {
      signal?.throwIfAborted();
      if (!pending && Date.now() - started >= 30_000) {
        started = Date.now();
        pending = (async () => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          signal?.addEventListener('abort', cancel, { once: true });
          const timer = setTimeout(() => controller.abort(), 3_000);
          try {
            // Deadline ограничивает весь fetch, включая чтение JSON.
            const response = await Promise.race([
              request(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }),
              new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('status/timeout')), { once: true })),
            ]);
            result = response.ok ? parseServiceStatus(await abortable(response.json(), controller.signal)) : { state: 'unknown' };
          } catch { result = { state: 'unknown' }; }
          finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending = undefined; }
          return cached();
        })();
      }
      if (!pending) return cached();
      return signal ? abortable(pending, signal) : pending;
    },
  };
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
