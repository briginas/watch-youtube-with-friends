import { useRef, useState } from 'react';
import { applyPopupTheme, savePopupTheme, type PopupTheme } from './theme';
import styles from './App.module.css';

export function ThemeToggle() {
  const [theme, setTheme] = useState<PopupTheme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [error, setError] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const selection = useRef(0);

  function toggle() {
    const next = theme === 'light' ? 'dark' : 'light';
    const operation = ++selection.current;
    setTheme(next);
    applyPopupTheme(next);
    setError(false);
    // Сохраняем быстрые повторные переключения в порядке выбора пользователя.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await savePopupTheme(next);
      } catch {
        if (operation === selection.current) setError(true);
      }
    });
  }

  return <>
    <button type="button" role="switch" aria-label="Тёмная тема" aria-checked={theme === 'dark'}
      className={styles.themeToggle} title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
      aria-describedby={error ? 'theme-save-error' : undefined} onClick={toggle}>
      {theme === 'dark'
        ? <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
        : <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8Z"/></svg>}
    </button>
    {error && <p id="theme-save-error" role="status" className={styles.themeError}>Не удалось сохранить тему. При следующем открытии выбор может сброситься.</p>}
  </>;
}
