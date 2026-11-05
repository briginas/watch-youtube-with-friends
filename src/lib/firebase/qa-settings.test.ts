import { expect, it } from 'vitest';
import { qaSettings } from './qa-settings';

const env = {
  CLOUD_FIREBASE_PROJECT_ID: 'custom-qa-project', WXT_FIREBASE_PROJECT_ID: 'custom-qa-project',
  WXT_CONTROL_PROJECT_ID: 'custom-qa-project', WXT_FIREBASE_API_KEY: 'fixture-key',
  WXT_FIREBASE_DATABASE_URL: 'https://custom-qa-project-default-rtdb.europe-west1.firebasedatabase.app',
  WXT_FIREBASE_INVITATION_BASE_URL: 'https://custom-qa-project.web.app/', WXT_BACKEND_GENERATION: 'qa-custom',
};
it('принимает собственный явно выбранный QA без project hardcode', () => {
  expect(qaSettings(env).projectId).toBe('custom-qa-project');
});
it.each([
  {}, { ...env, CLOUD_FIREBASE_PROJECT_ID: '' }, { ...env, CLOUD_FIREBASE_PROJECT_ID: 'another-project' },
  { ...env, WXT_CONTROL_PROJECT_ID: 'different-control' }, { ...env, WXT_BACKEND_GENERATION: 'prod-v1' },
  { ...env, WXT_FIREBASE_EMULATORS: '1' },
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('custom-qa-project', 'custom-production')])),
])('отклоняет неполную конфигурацию и чужую роль', values => {
  expect(() => qaSettings({ ...values, WXT_RELEASE: '1' })).toThrow('QA:');
});
