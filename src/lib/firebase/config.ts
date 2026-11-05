import { firebaseSettings, type FirebaseConfig } from './settings';
export type { FirebaseConfig } from './settings';

// Облако подключается отдельно. Обычная сборка без конфигурации не делает запросов.
export function firebaseConfig(): FirebaseConfig | null {
  // Release launcher уже проверил эти четыре поля. Статическая ветка позволяет
  // сборщику полностью удалить emulator-конфигурацию из production-пакета.
  if (import.meta.env.WXT_RELEASE === '1') return {
    apiKey: import.meta.env.WXT_FIREBASE_API_KEY!,
    projectId: import.meta.env.WXT_FIREBASE_PROJECT_ID!,
    databaseURL: new URL(import.meta.env.WXT_FIREBASE_DATABASE_URL!).origin,
    invitationBaseUrl: `${new URL(import.meta.env.WXT_FIREBASE_INVITATION_BASE_URL!).origin}/`,
    emulators: false,
    backendGeneration: import.meta.env.WXT_BACKEND_GENERATION!,
    controlProjectId: import.meta.env.WXT_CONTROL_PROJECT_ID!,
  };
  return firebaseSettings({
    WXT_FIREBASE_EMULATORS: import.meta.env.WXT_FIREBASE_EMULATORS,
    WXT_FIREBASE_API_KEY: import.meta.env.WXT_FIREBASE_API_KEY,
    WXT_FIREBASE_PROJECT_ID: import.meta.env.WXT_FIREBASE_PROJECT_ID,
    WXT_FIREBASE_DATABASE_URL: import.meta.env.WXT_FIREBASE_DATABASE_URL,
    WXT_FIREBASE_INVITATION_BASE_URL: import.meta.env.WXT_FIREBASE_INVITATION_BASE_URL,
    WXT_BACKEND_GENERATION: import.meta.env.WXT_BACKEND_GENERATION,
    WXT_CONTROL_PROJECT_ID: import.meta.env.WXT_CONTROL_PROJECT_ID,
  });
}

export const releaseVersion = __RELEASE_VERSION__;
export const backendGeneration = firebaseConfig()?.backendGeneration ?? 'unconfigured';
