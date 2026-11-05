import { classifyFailure, statusFailure, type Failure } from './connection-error';
import { abortable, type ServiceResult } from './service-status';

export type AttemptState = { phase: 'idle' | 'running' | 'waiting' | 'failed' | 'stopped' | 'succeeded'; failure: Failure | null; retryAt: number | null; retries: number };
/** Один владелец deadline, повторов и отмены. Callback не должен повторять записи. */
export function createConnectionAttempt(options: {
  run: (signal: AbortSignal) => Promise<void>;
  status: (signal: AbortSignal) => Promise<ServiceResult>;
  change: (state: AttemptState) => void;
  suspend?: () => void;
  random?: () => number;
}) {
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: AttemptState = { phase: 'idle', failure: null, retryAt: null, retries: 0 };
  const emit = () => options.change({ ...state });
  function cancel() { generation++; controller?.abort(); controller = undefined; clearTimeout(timer); }
  async function execute(current: number) {
    if (current !== generation) return;
    const operation = new AbortController(); controller = operation;
    state = { ...state, phase: 'running', retryAt: null, failure: null }; emit();
    const deadline = setTimeout(() => operation.abort(new DOMException('Deadline', 'TimeoutError')), 15_000);
    try {
      const status = await abortable(options.status(operation.signal), operation.signal);
      const announced = statusFailure(status);
      if (announced) throw Object.assign(new Error('service/status'), { failure: announced });
      await abortable(options.run(operation.signal), operation.signal);
      if (current !== generation) return;
      state = { ...state, phase: 'succeeded', failure: null }; emit();
    } catch (error) {
      if (current !== generation) return;
      const failure = error && typeof error === 'object' && 'failure' in error ? error.failure as Failure : classifyFailure(error);
      options.suspend?.();
      const retry = failure.retryable && state.retries < 4;
      const base = [10, 20, 40, 60][state.retries] ?? 60;
      const seconds = Math.min(300, Math.max(base * (1 + (options.random ?? Math.random)() * 0.2), failure.retryAfterSeconds ?? 0));
      state = { ...state, phase: retry ? 'waiting' : 'failed', failure, retryAt: retry ? Date.now() + seconds * 1000 : null };
      emit();
      if (retry) timer = setTimeout(() => { state.retries++; void execute(current); }, seconds * 1000);
    } finally { clearTimeout(deadline); operation.abort(); if (controller === operation) controller = undefined; }
  }
  return {
    snapshot: () => ({ ...state }),
    restart() { cancel(); state = { phase: 'idle', failure: null, retryAt: null, retries: 0 }; return execute(generation); },
    stop() { cancel(); state = { ...state, phase: 'stopped', retryAt: null }; options.suspend?.(); emit(); },
    dispose: cancel,
  };
}
