import { beforeEach, expect, it, vi } from 'vitest';
import { createReadOnlyEntry } from './read-only-entry';
const mocks = vi.hoisted(() => ({ client: vi.fn(), read: vi.fn() }));
vi.mock('../firebase/client', () => ({ getFirebaseClient: mocks.client }));
vi.mock('../firebase/config', () => ({ backendGeneration: 'emulator-v1', releaseVersion: '0.2.0', firebaseConfig: () => null }));
beforeEach(() => { mocks.read.mockReset().mockResolvedValue(null); mocks.client.mockReset().mockResolvedValue({ readRoom: mocks.read }); });
it('повторное приглашение активирует локально без Auth/read', async () => {
  const open = vi.fn();
  const owner = createReadOnlyEntry({ key: 'a'.repeat(64), activate: async () => true, open, change() {} });
  await owner.restart(); expect(owner.snapshot().phase).toBe('succeeded'); expect(mocks.client).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it('отменённый Auth не читает и не открывает позднюю вкладку', async () => {
  let resolve!: (client: unknown) => void;
  mocks.client.mockReturnValue(new Promise(yes => { resolve = yes; }));
  const open = vi.fn(); const owner = createReadOnlyEntry({ key: 'a'.repeat(64), activate: async () => false, open, change() {} });
  const pending = owner.restart(); for (let i = 0; i < 5; i++) await Promise.resolve();
  owner.stop(); resolve({ readRoom: mocks.read }); await pending;
  expect(mocks.read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(owner.snapshot().phase).toBe('stopped');
});
