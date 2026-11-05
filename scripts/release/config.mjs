import { parseEnv } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firebaseSettings } from '../../src/lib/firebase/settings.ts';

export const publicKeys = ['WXT_FIREBASE_API_KEY', 'WXT_FIREBASE_PROJECT_ID',
  'WXT_FIREBASE_DATABASE_URL', 'WXT_FIREBASE_INVITATION_BASE_URL', 'WXT_BACKEND_GENERATION', 'WXT_CONTROL_PROJECT_ID'];
const forbidden = ['WXT_FIREBASE_EMULATORS', 'WXT_FIREBASE_PROBE', 'WXT_PLAYER_PROBE'];

export function releaseSettings(values, inherited = {}) {
  if (forbidden.some(key => [values[key], inherited[key]].some(value => value && value !== '0'))) {
    throw new Error('Release: эмуляторы и экспериментальные сборки запрещены.');
  }
  if (Object.keys(values).some(key => key.startsWith('WXT_') && !publicKeys.includes(key))) {
    throw new Error('Release: неизвестный WXT-параметр в production-конфигурации.');
  }
  for (const key of [...publicKeys, 'RELEASE_FIREBASE_PROJECT_ID']) {
    if (!values[key]?.trim()) throw new Error('Release: production-конфигурация неполна.');
    if (inherited[key] !== undefined && inherited[key] !== values[key]) {
      throw new Error('Release: параметры процесса противоречат production-файлу.');
    }
  }
  let config;
  try { config = firebaseSettings({ ...values, WXT_RELEASE: '1' }); } catch { throw new Error('Release: некорректные Firebase-параметры.'); }
  if (!config || config.emulators || config.projectId !== values.RELEASE_FIREBASE_PROJECT_ID ||
      /(?:^|-)(?:qa|demo|test|control)(?:-|$)/i.test(config.projectId) ||
      /(?:^|-)(?:qa|demo|test)(?:-|$)/i.test(config.controlProjectId) || config.projectId === config.controlProjectId) {
    throw new Error('Release: нужен явно выбранный production-проект, отдельный от QA/demo/test.');
  }
  if (new URL(config.invitationBaseUrl).hostname !== `${config.controlProjectId}.web.app` ||
      !new URL(config.databaseURL).hostname.startsWith(`${config.projectId}-default-rtdb.`)) {
    throw new Error('Release: Firebase URL не принадлежат выбранному production-проекту.');
  }
  return config;
}

export function readProduction(inherited = process.env) {
  let values;
  try { values = parseEnv(readFileSync('.env.production', 'utf8')); }
  catch { throw new Error('Release: создайте локальный .env.production по .env.production.example.'); }
  return { config: releaseSettings(values, inherited), values };
}

export function buildEnvironment(values, inherited = process.env) {
  // Не передаём произвольные WXT/Vite env. Файлы, автоматически читаемые WXT,
  // отдельно проверяются перед запуском.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(?:WXT_|VITE_|FIREBASE_|RELEASE_)/.test(key)));
  for (const key of publicKeys) env[key] = values[key];
  return { ...env, WXT_RELEASE: '1', RELEASE_FIREBASE_PROJECT_ID: values.RELEASE_FIREBASE_PROJECT_ID };
}

export function assertBuildEnvFiles(values, directory = '.') {
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local',
    '.env.chrome', '.env.chrome.local', '.env.production.chrome', '.env.production.chrome.local']) {
    const file = resolve(directory, name);
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = parseEnv(readFileSync(file, 'utf8')); }
    catch { throw new Error('Release: не удалось проверить автоматически загружаемый env-файл.'); }
    for (const [key, value] of Object.entries(parsed)) {
      if (/^(?:WXT_|VITE_)/.test(key) && (!publicKeys.includes(key) || value !== values[key])) {
        throw new Error(`Release: конфликт автоматически загружаемого файла ${name}.`);
      }
    }
  }
}
