import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceStatusReader, parseServiceStatus } from './service-status';
const now = Date.parse('2026-11-04T12:00:00Z');
const value = (extra = {}) => ({ version: 1, state: 'operational', updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), ...extra });
afterEach(() => { vi.useRealTimers(); });
describe('публичный статус', () => {
  it.each([{ state: 'operational' }, { state: 'busy', retryAfterSeconds: 300 }, { state: 'unavailable', reason: 'quota' }, { state: 'unavailable', reason: 'maintenance' }])('принимает %j', extra => {
    expect(parseServiceStatus(value(extra), now).state).toBe(extra.state);
  });
  it.each([
    { version: 2 }, { message: '<img src=x>' }, { url: 'https://bad.example' }, { state: 'unavailable' },
    { state: 'busy', retryAfterSeconds: 301 }, { updatedAt: new Date(now + 300_001).toISOString() },
    { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 86_400_001).toISOString() },
    { updatedAt: '2026-11-04T12:00:00+00:00' },
  ])('отклоняет %j', extra => expect(parseServiceStatus(value(extra), now)).toEqual({ state: 'unknown' }));
  it('дедуплицирует, ограничивает ручные запросы и истечение; не опрашивает в фоне', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value())));
    const reader = createServiceStatusReader('https://invite.example/#private', fetcher);
    await Promise.all([reader.read(), reader.read()]);
    await reader.read(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toMatchObject(['https://invite.example/generations/emulator-v1/service-status.json', { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' }]);
    await vi.advanceTimersByTimeAsync(60_001); expect(reader.peek().state).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('unknown при deadline даже если fetch игнорирует abort; ошибка также throttled', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const reader = createServiceStatusReader('https://invite.example', fetcher);
    const pending = reader.read(); await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ state: 'unknown' }); await reader.read(); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(27_000); const next = reader.read(); await vi.advanceTimersByTimeAsync(3000); await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('отмена потребителя не принимает поздний ответ', async () => {
    const controller = new AbortController();
    const reader = createServiceStatusReader('https://invite.example', () => new Promise(() => {}));
    const promise = reader.read(controller.signal); controller.abort(); await expect(promise).rejects.toThrow();
  });
});
it('deadline включает тело ответа, отмена останавливает fetch', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let signal!: AbortSignal;
  const reader = createServiceStatusReader('https://invite.example', vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    signal = options!.signal!;
    return { ok: true, json: () => new Promise(() => {}) } as Response;
  }));
  const pending = reader.read(); await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ state: 'unknown' }); expect(signal.aborted).toBe(true);
});
