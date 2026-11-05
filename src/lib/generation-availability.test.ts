import { expect, it, vi } from 'vitest';
import { createGenerationAvailability, generationFailure } from './generation-availability';
import { firebaseSettings } from './firebase/settings';
const config = firebaseSettings({ WXT_FIREBASE_EMULATORS: '1' })!;
const registry = (state = 'active') => ({ schemaVersion: 1, revision: 1, updatedAt: '2020-01-01T00:00:00Z',
  generations: [{ generation: config.backendGeneration, firstRelease: '0.1.0', state, ...(state === 'retired' ? { retiredAt: '2020-01-01T00:00:00Z' } : {}) }] });
it('классифицирует оба направления несовместимости и unknown без смены backend', () => {
  const value = { schemaVersion: 1 as const, revision: 1, updatedAt: '2020-01-01T00:00:00Z', generations: [
    { generation: 'old', firstRelease: '0.9.0', state: 'active' as const },
    { generation: 'new', firstRelease: '0.10.0', state: 'active' as const }] };
  expect(generationFailure(value, 'new', 'old', '0.9.1')).toBe('generation-update-required');
  expect(generationFailure(value, 'old', 'new', '0.10.0')).toBe('unsupported-generation');
  expect(generationFailure(null, 'other', 'old', '0.9.1')).toBe('unsupported-generation');
  expect(generationFailure(null, 'old', 'old', '0.9.1')).toBeNull();
});
it('retired имеет приоритет над busy/operational; foreign запрашивает только реестр', async () => {
  const request = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).endsWith('backend-generations.json') ? registry('retired') : {
    version: 1, state: 'busy', updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })));
  const gate = createGenerationAvailability(config, request);
  await expect(gate.read()).rejects.toThrow('generation-retired');
  expect(request.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    'http://127.0.0.1:5002/backend-generations.json', 'http://127.0.0.1:5002/generations/emulator-v1/service-status.json',
  ]));
  request.mockClear(); const other = createGenerationAvailability(config, request);
  await expect(other.read(undefined, 'other')).rejects.toThrow('unsupported-generation');
  expect(request).toHaveBeenCalledTimes(1);
});
it('unknown реестр не блокирует собственный вход, статус другого поколения не читается', async () => {
  const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }));
  expect(await createGenerationAvailability(config, request).read()).toEqual({ state: 'unknown' });
  expect(request.mock.calls.every(([url]) => !String(url).includes('9000') && !String(url).includes('9099'))).toBe(true);
});
