import { t } from './i18n';
import type { ServiceResult } from './service-status';

export type FailureKind = 'network-or-timeout' | 'auth-rate-limited' | 'auth-failed' | 'access-denied'
  | 'not-found' | 'unsupported-room' | 'service-busy' | 'service-unavailable'
  | 'generation-retired' | 'generation-update-required' | 'unsupported-generation';
export type Failure = { kind: FailureKind; stage: 'auth' | 'connect' | 'read'; retryable: boolean; reason?: 'quota' | 'maintenance'; retryAfterSeconds?: number };
export class ConnectionError extends Error {
  failure: Failure;
  constructor(kind: FailureKind, stage: Failure['stage'] = 'read') {
    super(kind);
    this.failure = { kind, stage, retryable: kind === 'network-or-timeout' || kind === 'service-busy' };
  }
}
export function classifyFailure(error: unknown, stage: Failure['stage'] = 'read'): Failure {
  if (error instanceof ConnectionError) return error.failure;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const kind: FailureKind = code === 'auth/too-many-requests' ? 'auth-rate-limited'
    : /^(?:PERMISSION_DENIED|permission_denied|database\/permission-denied)$/.test(code) ? 'access-denied'
      : code.startsWith('auth/') && code !== 'auth/network-request-failed' ? 'auth-failed' : 'network-or-timeout';
  return { kind, stage, retryable: kind === 'network-or-timeout' };
}
export function statusFailure(status: ServiceResult): Failure | null {
  if (status.state === 'busy') return { kind: 'service-busy', stage: 'connect', retryable: true, retryAfterSeconds: status.retryAfterSeconds };
  if (status.state === 'unavailable') return { kind: 'service-unavailable', stage: 'connect', retryable: false, reason: status.reason };
  return null;
}
export function generationBlocksEntry(failure?: Failure | null): boolean {
  return failure?.kind === 'generation-retired' || failure?.kind === 'generation-update-required' ||
    failure?.kind === 'unsupported-generation';
}
export function failureMessage(failure: Failure): string {
  return {
    'network-or-timeout': t('networkFailure'),
    'auth-rate-limited': t('authRateLimited'),
    'auth-failed': t('authFailed'),
    'access-denied': t('accessDenied'),
    'not-found': t('roomNotFound'),
    'unsupported-room': t('unsupportedRoom'),
    'generation-retired': t('generationRetired'),
    'generation-update-required': t('generationUpdateRequired'),
    'unsupported-generation': t('unsupportedGeneration'),
    'service-busy': t('serviceBusy'),
    'service-unavailable': failure.reason === 'quota' ? t('serviceQuota') : t('serviceMaintenance'),
  }[failure.kind];
}
