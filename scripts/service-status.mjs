import { resolve, join } from 'node:path';
import { parseServiceStatus } from '../src/lib/service-status.ts';
import { generationSchema, parseRegistry } from '../src/lib/backend-generations.ts';
import { json, readJson } from './release/generation.mjs';

export function prepareStatus(state, { reason, seconds = 3600, retryAfterSeconds } = {}, now = Date.now()) {
  const value = { version: 1, state, updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + Number(seconds) * 1000).toISOString(),
    ...(reason ? { reason } : {}), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds: Number(retryAfterSeconds) } : {}) };
  if (parseServiceStatus(value, now).state === 'unknown') throw new Error('Status: некорректное состояние, причина или TTL (1–86400 секунд).');
  return value;
}
export function updateStatus(source, generation, value) {
  const registry = parseRegistry(readJson(join(source, 'backend-generations.json')));
  if (!generationSchema.safeParse(generation).success ||
      !registry?.generations.some(entry => entry.generation === generation))
    throw new Error('Status: поколение отсутствует в реестре.');
  if (parseServiceStatus(value).state === 'unknown') throw new Error('Status: статус не прошёл проверку.');
  json(join(source, 'generations', generation, 'service-status.json'), value);
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [command, generation, state, reason, seconds, retryAfterSeconds] = process.argv.slice(2);
    if (command !== 'prepare') throw new Error('Status: команда prepare <generation> <operational|busy|unavailable> <reason|-> <TTL seconds> [retry seconds].');
    const value = prepareStatus(state, { reason: reason === '-' ? undefined : reason, seconds: seconds ?? 3600, retryAfterSeconds });
    updateStatus('.local/deployment/control', generation, value);
    console.log('Status: файл поколения подготовлен.');
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith('Status:') ? error.message : 'Status: операция не выполнена; конфигурация и вывод дочернего процесса скрыты.');
    process.exitCode = 1;
  }
}
