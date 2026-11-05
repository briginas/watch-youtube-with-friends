import { afterEach, expect, it, vi } from 'vitest';
import { createGenerationRegistryReader } from './generation-registry';
afterEach(() => vi.useRealTimers());
const document = { schemaVersion: 1, revision: 1, updatedAt: '2020-01-01T00:00:00Z',
  generations: [{ generation: 'old', firstRelease: '0.1.0', state: 'retired', retiredAt: '2020-01-01T00:00:00Z' }] };
it('singleflight, 30s interval, 60s cache, постоянные retired; только публичный GET', async () => {
  vi.useFakeTimers();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(document)));
  const reader = createGenerationRegistryReader('https://control.example/#room=private', request);
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  expect(a).toEqual(document); expect(b).toEqual(a); expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual(['https://control.example/backend-generations.json', expect.objectContaining({
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: expect.any(AbortSignal),
  })]);
  await reader.read(); expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000); await reader.read(); expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000); expect(reader.peek()).toBeNull();
  request.mockRejectedValue(new Error('network')); expect(await reader.read()).toBeNull();
});
it('deadline включает JSON, отмена не оставляет поздний cache', async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  const request = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(yes => { resolve = yes; }) });
  const reader = createGenerationRegistryReader('https://control.example', request);
  const pending = reader.read(); await vi.advanceTimersByTimeAsync(3_000);
  expect(await pending).toBeNull(); resolve(document); await Promise.resolve(); expect(reader.peek()).toBeNull();
  await vi.advanceTimersByTimeAsync(30_000);
  const controller = new AbortController();
  const cancelled = reader.read(controller.signal); controller.abort();
  await expect(cancelled).rejects.toThrow(); expect(reader.peek()).toBeNull();
});
it.each([new Response('invalid'), new Response('{}', { status: 503 }), new Response(JSON.stringify({ ...document, databaseURL: 'https://other' }))])('недостоверный ответ не выбирает backend', async response => {
  expect(await createGenerationRegistryReader('https://control.example', async () => response).read()).toBeNull();
});
