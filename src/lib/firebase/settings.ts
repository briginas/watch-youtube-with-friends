export interface FirebaseConfig {
  apiKey: string;
  projectId: string;
  databaseURL: string;
  emulators: boolean;
  invitationBaseUrl: string;
  backendGeneration: string;
  controlProjectId: string;
}

/** Общая проверка настроек для runtime, manifest и облачного стенда. */
export function firebaseSettings(env: Record<string, string | undefined>): FirebaseConfig | null {
  if (env.WXT_FIREBASE_EMULATORS === '1') return {
    apiKey: 'demo-key-not-a-production-credential',
    projectId: 'demo-watch-together',
    databaseURL: 'https://demo-watch-together-default-rtdb.firebaseio.com',
    emulators: true,
    invitationBaseUrl: 'http://127.0.0.1:5002/',
    backendGeneration: 'emulator-v1',
    controlProjectId: 'demo-watch-together',
  };
  const values = [env.WXT_FIREBASE_API_KEY, env.WXT_FIREBASE_PROJECT_ID,
    env.WXT_FIREBASE_DATABASE_URL, env.WXT_FIREBASE_INVITATION_BASE_URL,
    env.WXT_BACKEND_GENERATION, env.WXT_CONTROL_PROJECT_ID];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value?.trim())) throw new Error('Firebase: задайте backend, generation и control параметры.');
  const [apiKey, projectId, databaseURL, invitationBaseUrl, backendGeneration, controlProjectId] = values as [string, string, string, string, string, string];
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')) {
    throw new Error('Firebase: нужен ID настоящего тестового проекта.');
  }
  const database = new URL(databaseURL);
  const invitation = new URL(invitationBaseUrl);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(backendGeneration) ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(controlProjectId) ||
      invitation.hostname !== `${controlProjectId}.web.app`) throw new Error('Firebase: неверные generation/control параметры.');
  for (const url of [database, invitation]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Firebase: облачные URL должны быть HTTPS origin без пути, query или fragment.');
    }
  }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(?:firebaseio\.com|firebasedatabase\.app)$/.test(database.hostname)) {
    throw new Error('Firebase: ожидается URL Firebase Realtime Database.');
  }
  if (!(database.hostname === `${projectId}.firebaseio.com` ||
      database.hostname === `${projectId}-default-rtdb.firebaseio.com` ||
      new RegExp(`^${projectId}-default-rtdb\\.[a-z0-9-]+\\.firebasedatabase\\.app$`).test(database.hostname)))
    throw new Error('Firebase: база не принадлежит backend-проекту.');
  if (env.WXT_RELEASE !== '1' && /(?:^|-)(?:prod|production)(?:-|$)/.test(`${projectId}-${controlProjectId}`))
    throw new Error('Firebase: production endpoints запрещены в QA.');
  return { apiKey, projectId, databaseURL: database.origin, invitationBaseUrl: `${invitation.origin}/`,
    backendGeneration, controlProjectId, emulators: false };
}
