import { describe, expect, it } from 'vitest';
import { firebaseSettings } from './settings';

const cloud = {
  WXT_FIREBASE_API_KEY: 'public-web-api-key',
  WXT_FIREBASE_PROJECT_ID: 'watch-together-qa',
  WXT_FIREBASE_DATABASE_URL: 'https://watch-together-qa-default-rtdb.europe-west1.firebasedatabase.app/',
  WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-qa.web.app/',
  WXT_CONTROL_PROJECT_ID: 'watch-together-qa',
  WXT_BACKEND_GENERATION: 'qa-v1',
};

describe('Firebase build settings', () => {
  it('без настроек не подключает сервер, а локальный флаг всегда выбирает эмулятор', () => {
    expect(firebaseSettings({})).toBeNull();
    expect(firebaseSettings({ ...cloud, WXT_FIREBASE_EMULATORS: '1' })).toMatchObject({ emulators: true, projectId: 'demo-watch-together' });
  });
  it('принимает региональный RTDB и старый firebaseio.com', () => {
    expect(firebaseSettings(cloud)).toMatchObject({ emulators: false, databaseURL: cloud.WXT_FIREBASE_DATABASE_URL.slice(0, -1) });
    expect(firebaseSettings({ ...cloud, WXT_FIREBASE_DATABASE_URL: 'https://watch-together-qa.firebaseio.com' })).not.toBeNull();
  });
  it.each([
    { WXT_FIREBASE_API_KEY: '' },
    { WXT_BACKEND_GENERATION: '' },
    { WXT_CONTROL_PROJECT_ID: 'other-project' },
    { WXT_FIREBASE_DATABASE_URL: 'https://other-project.firebaseio.com' },
    { WXT_FIREBASE_PROJECT_ID: 'demo-watch-together' },
    { WXT_FIREBASE_DATABASE_URL: 'https://example.com/' },
    { WXT_FIREBASE_DATABASE_URL: 'http://watch-together-qa.firebaseio.com/' },
    { WXT_FIREBASE_INVITATION_BASE_URL: 'http://watch-together-qa.web.app/' },
    { WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-qa.web.app/other' },
    { WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-qa.web.app/?room=secret' },
    { WXT_FIREBASE_INVITATION_BASE_URL: 'https://user:password@watch-together-qa.web.app/' },
  ])('отклоняет неполную или недоверенную конфигурацию: %j', override => {
    expect(() => firebaseSettings({ ...cloud, ...override })).toThrow();
  });
  it('QA не принимает production endpoints; эмулятор игнорирует их', () => {
    const production = { ...cloud, WXT_FIREBASE_PROJECT_ID: 'watch-production',
      WXT_FIREBASE_DATABASE_URL: 'https://watch-production.firebaseio.com' };
    expect(() => firebaseSettings(production)).toThrow('production');
    const emulator = firebaseSettings({ ...production, WXT_FIREBASE_EMULATORS: '1' });
    expect(JSON.stringify(emulator)).not.toContain('watch-production');
  });
});
