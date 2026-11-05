import { describe, expect, it } from 'vitest';
import { buildEnvironment, releaseSettings } from '../../scripts/release/config.mjs';

export const production = {
  RELEASE_FIREBASE_PROJECT_ID: 'watch-together-production',
  WXT_FIREBASE_API_KEY: 'public-web-api-key',
  WXT_FIREBASE_PROJECT_ID: 'watch-together-production',
  WXT_FIREBASE_DATABASE_URL: 'https://watch-together-production-default-rtdb.europe-west1.firebasedatabase.app',
  WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-control.web.app/',
  WXT_CONTROL_PROJECT_ID: 'watch-together-control',
  WXT_BACKEND_GENERATION: 'g-fixture',
};

describe('release environment', () => {
  it('принимает только явную согласованную конфигурацию', () => {
    expect(releaseSettings(production).projectId).toBe(production.RELEASE_FIREBASE_PROJECT_ID);
    expect(buildEnvironment(production, { WXT_SECRET: 'never-embed', VITE_TOKEN: 'never-embed', PATH: '/bin' }))
      .toMatchObject({ WXT_RELEASE: '1', PATH: '/bin' });
    expect(buildEnvironment(production, { WXT_SECRET: 'never-embed', VITE_TOKEN: 'never-embed' }))
      .not.toHaveProperty('WXT_SECRET');
  });
  it.each([
    { WXT_FIREBASE_API_KEY: '' }, { RELEASE_FIREBASE_PROJECT_ID: 'another-project' },
    { WXT_FIREBASE_PROJECT_ID: 'example-qa' },
    { WXT_FIREBASE_DATABASE_URL: 'https://another-project.firebaseio.com' },
    { WXT_FIREBASE_INVITATION_BASE_URL: 'https://another-project.web.app/' },
    { WXT_CONTROL_PROJECT_ID: 'watch-together-production', WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-production.web.app/' },
    { WXT_BACKEND_GENERATION: '../legacy' }, { WXT_BACKEND_GENERATION: '' },
    { WXT_FIREBASE_PROBE: '1' }, { WXT_PLAYER_PROBE: '1' }, { WXT_FIREBASE_EMULATORS: '1' },
    { WXT_UNKNOWN: 'synthetic-private-value' },
  ])('отказывается без раскрытия значений: %j', override => {
    expect(() => releaseSettings({ ...production, ...override })).toThrow(/^Release:/);
    try { releaseSettings({ ...production, ...override }); } catch (error) {
      expect(String(error)).not.toContain('synthetic-private-value');
    }
  });
  it('не позволяет переменным процесса подменить файл', () => {
    expect(() => releaseSettings(production, { WXT_FIREBASE_API_KEY: 'other-key' })).toThrow('противоречат');
    expect(() => releaseSettings(production, { WXT_FIREBASE_EMULATORS: '1' })).toThrow('запрещены');
  });
});
