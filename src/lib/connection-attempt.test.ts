import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConnectionAttempt } from './connection-attempt';
import { classifyFailure, ConnectionError, failureMessage } from './connection-error';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('deadline включает зависший Auth; четыре повтора 10/20/40/60, затем остановка', async () => {
  const run = vi.fn(() => new Promise<void>(() => {})), suspend = vi.fn();
  const owner = createConnectionAttempt({ run, suspend, status: async () => ({ state: 'unknown' }), change() {}, random: () => 0 });
  const first = owner.restart(); await vi.advanceTimersByTimeAsync(15_000); await first;
  for (const seconds of [10, 20, 40, 60]) {
    expect(owner.snapshot().phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(seconds * 1000 + 15_000);
  }
  expect(run).toHaveBeenCalledTimes(5); expect(suspend).toHaveBeenCalledTimes(5);
  expect(owner.snapshot()).toMatchObject({ phase: 'failed', retries: 4, retryAt: null });
  await vi.advanceTimersByTimeAsync(500_000); expect(run).toHaveBeenCalledTimes(5);
});
it('manual заменяет серию; поздний run и отменённый таймер не дают успех', async () => {
  let resolve!: () => void;
  const run = vi.fn(() => new Promise<void>(yes => { resolve = yes; }));
  const owner = createConnectionAttempt({ run, status: async () => ({ state: 'unknown' }), change() {} });
  const first = owner.restart(); await vi.advanceTimersByTimeAsync(0); const old = resolve;
  const second = owner.restart(); await vi.advanceTimersByTimeAsync(0); old(); await first;
  expect(run).toHaveBeenCalledTimes(2); expect(owner.snapshot().phase).toBe('running');
  owner.stop(); resolve(); await second; await vi.advanceTimersByTimeAsync(500_000);
  expect(owner.snapshot().phase).toBe('stopped'); expect(run).toHaveBeenCalledTimes(2);
});
it('stop меняет состояние до синхронного callback отключения SDK', async () => {
  let observed: string | undefined;
  const owner = createConnectionAttempt({ run: async () => {}, status: async () => ({ state: 'unknown' }), change() {},
    suspend() { observed = owner.snapshot().phase; },
  });
  await owner.restart(); owner.stop();
  expect(observed).toBe('stopped');
});
it('busy откладывает до 300с; expired unknown разрешает вход; unavailable не запускает Auth', async () => {
  const run = vi.fn(async () => {});
  const status = vi.fn().mockResolvedValueOnce({ state: 'busy', retryAfterSeconds: 300 }).mockResolvedValue({ state: 'unknown' });
  const owner = createConnectionAttempt({ run, status, change() {}, random: () => 0 });
  await owner.restart(); expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300_000); expect(run).toHaveBeenCalledTimes(1); expect(owner.snapshot().phase).toBe('succeeded');
  status.mockResolvedValue({ state: 'unavailable', reason: 'quota' }); await owner.restart();
  expect(owner.snapshot()).toMatchObject({ phase: 'failed', failure: { kind: 'service-unavailable' } });
  await vi.advanceTimersByTimeAsync(500_000); expect(run).toHaveBeenCalledTimes(1);
});
it.each(['not-found', 'unsupported-room', 'access-denied', 'auth-rate-limited'] as const)('не повторяет %s', async kind => {
  const owner = createConnectionAttempt({ run: async () => { throw new ConnectionError(kind); }, status: async () => ({ state: 'unknown' }), change() {} });
  await owner.restart(); expect(owner.snapshot().phase).toBe('failed'); expect(owner.snapshot().retryAt).toBeNull();
});
it('классификация не выводит quota из SDK/HTTP/timeout и скрывает детали', () => {
  for (const error of [new Error('429 quota secret'), new DOMException('', 'TimeoutError'), { status: 403 }, { code: 'auth/network-request-failed' }]) {
    expect(classifyFailure(error).kind).toBe('network-or-timeout'); expect(failureMessage(classifyFailure(error))).not.toContain('secret');
  }
  expect(classifyFailure({ code: 'auth/too-many-requests' })).toMatchObject({ kind: 'auth-rate-limited', retryable: false });
  expect(classifyFailure({ code: 'PERMISSION_DENIED' }).kind).toBe('access-denied');
});
