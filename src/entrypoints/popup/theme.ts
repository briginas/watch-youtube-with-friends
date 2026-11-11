import { browser } from 'wxt/browser';

export type PopupTheme = 'light' | 'dark';
export const popupThemeKey = 'watch-together:popup-theme:v1';

export function applyPopupTheme(theme: PopupTheme) {
  document.documentElement.dataset.theme = theme;
}

export async function loadPopupTheme(): Promise<PopupTheme> {
  try {
    const stored = await browser.storage.local.get(popupThemeKey);
    return stored[popupThemeKey] === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export async function savePopupTheme(theme: PopupTheme) {
  await browser.storage.local.set({ [popupThemeKey]: theme });
}
