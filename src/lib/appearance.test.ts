import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: { storage: {
  local: { get: storage.get, set: storage.set },
  onChanged: { addListener: storage.addListener, removeListener: storage.removeListener },
} } }));

import { appearanceThemeKey as key, loadAppearanceTheme, observeAppearanceTheme, saveAppearanceTheme } from './appearance';

describe('appearance preference', () => {
  let dataset: Record<string, string>;
  beforeEach(() => {
    vi.resetAllMocks();
    dataset = {};
    vi.stubGlobal('document', { documentElement: { dataset } });
    storage.get.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the existing profile key and normalizes missing/unknown values', async () => {
    expect(key).toBe('watch-together:popup-theme:v1');
    for (const value of [undefined, 'unknown', null, 'light', false]) {
      storage.get.mockResolvedValue({ [key]: value });
      expect(await loadAppearanceTheme()).toBe('light');
    }
    storage.get.mockResolvedValue({ [key]: 'dark' });
    expect(await loadAppearanceTheme()).toBe('dark');
    await saveAppearanceTheme('dark');
    expect(storage.set).toHaveBeenCalledWith({ [key]: 'dark' });
  });

  it('falls back on read failure but propagates save failure to the popup', async () => {
    storage.get.mockRejectedValue(new Error('unavailable'));
    const observer = observeAppearanceTheme();
    await observer.ready;
    expect(dataset.theme).toBe('light');
    storage.set.mockRejectedValue(new Error('save failed'));
    await expect(saveAppearanceTheme('dark')).rejects.toThrow('save failed');
    observer.dispose();
  });

  it('applies saved choice, follows local changes and deletion, ignores unrelated events', async () => {
    storage.get.mockResolvedValue({ [key]: 'dark' });
    const observer = observeAppearanceTheme();
    await observer.ready;
    expect(dataset.theme).toBe('dark');
    const listener = storage.addListener.mock.calls[0]![0];
    listener({ other: { newValue: 'light' } }, 'local');
    listener({ [key]: { newValue: 'light' } }, 'sync');
    expect(dataset.theme).toBe('dark');
    listener({ [key]: { oldValue: 'dark' } }, 'local');
    expect(dataset.theme).toBe('light');
    listener({ [key]: { newValue: 'dark' } }, 'local');
    expect(dataset.theme).toBe('dark');
    listener({ [key]: { newValue: 'invalid' } }, 'local');
    expect(dataset.theme).toBe('light');
    observer.dispose();
    expect(storage.removeListener).toHaveBeenCalledWith(listener);
  });

  it('does not overwrite a storage event with a stale initial read', async () => {
    let resolveRead!: (value: object) => void;
    storage.get.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    const observer = observeAppearanceTheme();
    storage.addListener.mock.calls[0]![0]({ [key]: { newValue: 'dark' } }, 'local');
    resolveRead({ [key]: 'light' });
    await observer.ready;
    expect(dataset.theme).toBe('dark');
    observer.dispose();
  });

  it('does not apply a late read after disposal', async () => {
    const observer = observeAppearanceTheme();
    observer.dispose();
    await observer.ready;
    expect(dataset.theme).toBeUndefined();
  });
});
