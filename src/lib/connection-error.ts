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
    'network-or-timeout': 'Не удалось получить актуальное состояние комнаты. Проверьте интернет или повторите позже.',
    'auth-rate-limited': 'Слишком много попыток входа. Попробуйте позже.',
    'auth-failed': 'Не удалось выполнить анонимный вход. Повторите позже.',
    'access-denied': 'Нет доступа к комнате. Проверьте приглашение.',
    'not-found': 'Комната не найдена.',
    'unsupported-room': 'Формат комнаты не поддерживается. Создайте новую комнату.',
    'generation-retired': 'Поддержка этой комнаты завершена. Обновите расширение, откройте нужное видео и создайте новую комнату.',
    'generation-update-required': 'Для этой комнаты нужна более новая версия расширения. Обновите расширение и снова откройте приглашение.',
    'unsupported-generation': 'Эта версия расширения не поддерживает поколение комнаты. Откройте нужное видео и создайте новую комнату.',
    'service-busy': 'Сервис перегружен. Подождите следующую попытку или повторите позже.',
    'service-unavailable': failure.reason === 'quota' ? 'Ресурсы сервиса временно исчерпаны. Попробуйте позже.' : 'Сервис временно недоступен: идёт обслуживание. Попробуйте позже.',
  }[failure.kind];
}
