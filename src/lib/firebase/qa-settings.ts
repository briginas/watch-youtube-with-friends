import { firebaseSettings, type FirebaseConfig } from './settings.ts';

/** Explicit QA selection is separate from the client configuration. */
export function qaSettings(env: Record<string, string | undefined>): FirebaseConfig {
  let config: FirebaseConfig | null;
  try { config = firebaseSettings({ ...env, WXT_RELEASE: '0' }); }
  catch { throw new Error('QA: заполните согласованные параметры .env.cloud по .env.example.'); }
  if (!config || config.emulators || !env.CLOUD_FIREBASE_PROJECT_ID?.trim() ||
      config.projectId !== env.CLOUD_FIREBASE_PROJECT_ID || config.controlProjectId !== config.projectId ||
      !config.backendGeneration.startsWith('qa-') ||
      /(?:^|-)(?:prod|production|control)(?:-|$)/i.test(config.projectId)) {
    throw new Error('QA: выберите отдельный CLOUD_FIREBASE_PROJECT_ID, одинаковые QA backend/control и поколение qa-*.');
  }
  return config;
}
