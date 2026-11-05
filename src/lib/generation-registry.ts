import { parseRegistry, type RegistryResult } from './backend-generations';
import { abortable } from './service-status';

/** Чтение публичного документа по явному действию. Auth/RTDB здесь не используются. */
export function createGenerationRegistryReader(base: string, request: typeof fetch = fetch) {
  const url = new URL('/backend-generations.json', base).href;
  let started = -Infinity;
  let result: RegistryResult = null;
  let pending: Promise<RegistryResult> | undefined;
  const cached = () => Date.now() - started < 60_000 ? result : null;
  return {
    peek: cached,
    async read(signal?: AbortSignal): Promise<RegistryResult> {
      signal?.throwIfAborted();
      if (!pending && Date.now() - started >= 30_000) {
        started = Date.now();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, 3_000);
        pending = (async () => {
          try {
            const response = await abortable(request(url, { signal: controller.signal,
              cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }), controller.signal);
            result = response.ok ? parseRegistry(await abortable(response.json(), controller.signal)) : null;
          } catch { result = null; }
          finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
          return cached();
        })().finally(() => { pending = undefined; });
      }
      return pending ? (signal ? abortable(pending, signal) : pending) : cached();
    },
  };
}
