import { browser } from 'wxt/browser';

export type AppearanceTheme = 'light' | 'dark';
// Keep the existing profile preference when sharing themes with the session UI.
export const appearanceThemeKey = 'watch-together:popup-theme:v1';

function themeValue(value: unknown): AppearanceTheme {
  return value === 'dark' ? 'dark' : 'light';
}

export function applyAppearanceTheme(theme: AppearanceTheme) {
  document.documentElement.dataset.theme = theme;
}

export async function loadAppearanceTheme(): Promise<AppearanceTheme> {
  try {
    const stored = await browser.storage.local.get(appearanceThemeKey);
    return themeValue(stored[appearanceThemeKey]);
  } catch {
    return 'light';
  }
}

export async function saveAppearanceTheme(theme: AppearanceTheme) {
  await browser.storage.local.set({ [appearanceThemeKey]: theme });
}

export function observeAppearanceTheme() {
  let revision = 0;
  let disposed = false;
  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, appearanceThemeKey)) return;
    revision += 1;
    applyAppearanceTheme(themeValue(changes[appearanceThemeKey]?.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  const initialRevision = revision;
  const ready = loadAppearanceTheme().then(theme => {
    if (!disposed && revision === initialRevision) applyAppearanceTheme(theme);
  });
  return {
    ready,
    dispose() {
      disposed = true;
      browser.storage.onChanged.removeListener(listener);
    },
  };
}
