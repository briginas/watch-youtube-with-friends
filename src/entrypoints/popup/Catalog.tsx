import { backendGeneration } from '../../lib/firebase/config';
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { firebaseConfig } from '../../lib/firebase/config';
import { closeFirebaseClient } from '../../lib/firebase/client';
import { createReadOnlyEntry } from '../../lib/room/read-only-entry';
import type { AttemptState } from '../../lib/connection-attempt';
import { failureMessage } from '../../lib/connection-error';
import type { CatalogEntry, CatalogPopupSnapshot } from '../../lib/room/catalog';
import styles from './App.module.css';

async function request(action: string, extra = {}) {
  const result = await browser.runtime.sendMessage({ type: 'room-catalog', backendGeneration, action, ...extra });
  if (!result || result.error) throw new Error(result?.error ?? 'Не удалось прочитать список комнат. Повторите действие.');
  return result;
}

export function Catalog() {
  const [snapshot, setSnapshot] = useState<CatalogPopupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<{ key: string; action: 'open' | 'remove' } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const entryOwner = useRef<ReturnType<typeof createReadOnlyEntry> | null>(null);
  const entryOperation = useRef<string | null>(null);
  const [recovery, setRecovery] = useState<AttemptState | null>(null);
  const [, tick] = useState(0);
  function cancelEntry() {
    entryOwner.current?.stop();
    if (entryOperation.current) void requestEntryCancel(entryOperation.current);
    entryOperation.current = null; setBusy(null);
  }
  async function requestEntryCancel(operation: string) {
    try { await browser.runtime.sendMessage({ type: 'room-entry', action: 'cancel', operation }); } catch { /* документ закрывается */ }
  }
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let loadId = 0;
    const load = () => {
      if (!firebaseConfig()) return;
      const id = ++loadId;
      void request('list').then(value => {
        if (!controller.signal.aborted && id === loadId) { setSnapshot(value); setError(null); }
      }, () => { if (!controller.signal.aborted && id === loadId) setError('Не удалось прочитать список комнат. Повторите действие.'); });
    };
    const changed = (_changes: unknown, area: string) => { if (area === 'local' || area === 'session') load(); };
    const close = () => { controller.abort(); entryOwner.current?.stop(); if (entryOperation.current) void requestEntryCancel(entryOperation.current); void closeFirebaseClient(); };
    load();
    browser.storage.onChanged.addListener(changed);
    browser.tabs.onActivated.addListener(load);
    browser.tabs.onRemoved.addListener(load);
    browser.windows.onFocusChanged.addListener(load);
    addEventListener('pagehide', close);
    return () => {
      close(); browser.storage.onChanged.removeListener(changed);
      browser.tabs.onActivated.removeListener(load);
      browser.tabs.onRemoved.removeListener(load);
      browser.windows.onFocusChanged.removeListener(load);
      removeEventListener('pagehide', close);
    };
  }, [attempt]);

  async function operate(entry: CatalogEntry, remove = false) {
    if (busy) return;
    setBusy({ key: entry.key, action: remove ? 'remove' : 'open' });
    setErrors(value => ({ ...value, [entry.key]: null }));
    try {
      if (remove) {
        await request('remove', { key: entry.key });
        setSnapshot(await request('list'));
        return;
      }
      entryOwner.current?.stop();
      entryOwner.current = createReadOnlyEntry({ key: entry.key,
        change(state) {
          if (lifetime.current?.signal.aborted) return;
          setRecovery(state);
          setErrors(value => ({ ...value, [entry.key]: state.failure ? failureMessage(state.failure) : null }));
          if (['succeeded', 'failed', 'stopped'].includes(state.phase)) setBusy(null);
        },
        async activate(signal) {
          const id = crypto.randomUUID(); entryOperation.current = id;
          const cancel = () => { void requestEntryCancel(id); };
          signal.addEventListener('abort', cancel, { once: true });
          await browser.runtime.sendMessage({ type: 'room-entry', action: 'begin', operation: id });
          if (signal.aborted) { cancel(); signal.throwIfAborted(); }
          const active = await request('activate', { key: entry.key, operation: id });
          signal.throwIfAborted();
          if (active.catalogError) throw new Error('catalog/save');
          return !!active.opened;
        },
        async open(room, signal) {
          signal.throwIfAborted();
          const opened = await request('open', { operation: entryOperation.current, room: {
            key: entry.key, videoId: room.playback.videoId, name: room.metadata.name, backendGeneration,
          } });
          signal.throwIfAborted();
          if (!opened.opened) throw new Error('entry/cancelled');
          if (opened.catalogError) throw new Error('catalog/save');
        },
      });
      void entryOwner.current.restart();
      return;
    } catch (failure) {
      if (!lifetime.current?.signal.aborted) setErrors(value => ({
        ...value, [entry.key]: failure instanceof Error ? failure.message : 'Не удалось выполнить действие.',
      }));
    } finally { if (remove) setBusy(null); }
  }

  return <section className={styles.catalog} aria-label="Мои комнаты">
    <h2>Мои комнаты</h2>
    {!firebaseConfig() ? <p>Подключение к серверу ещё не настроено.</p>
      : <>
        {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Повторить загрузку списка</button></p>}
        {!snapshot && !error && <p>Загружаем список…</p>}
        {snapshot?.warning && <p role="alert">{snapshot.warning}</p>}
        {snapshot?.entries.length === 0 && <p>Здесь появятся созданные и принятые комнаты.</p>}
        {!!snapshot?.entries.length && <ul>{snapshot.entries.map(entry => <li key={entry.key}>
          <div className={styles.catalogRow}>
            <span className={styles.roomName}>{entry.name}</span>
            {busy?.key === entry.key && busy.action === 'open'
              ? <div className={styles.pendingEntry}>
                <span role="status">
                  <span className={styles.spinner} aria-hidden="true" />
                  <span className={styles.srOnly}>Открываем комнату…</span>
                </span>
                <button type="button" onClick={cancelEntry}>Отмена</button>
              </div>
              : snapshot.tabStates[entry.key] === 'current'
              ? <span className={styles.currentRoom}>В этой вкладке</span>
              : <button disabled={!!busy} onClick={() => { void operate(entry); }}>{snapshot.tabStates[entry.key] === 'other' ? 'Перейти' : 'Открыть'}</button>}
            <button type="button" className={styles.iconButton} aria-label="Убрать из списка" title="Убрать из списка"
              disabled={!!busy} onClick={() => { void operate(entry, true); }}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>
            </button>
          </div>
          {errors[entry.key] && <p role="alert">{errors[entry.key]}</p>}
          {busy?.key === entry.key && busy.action === 'open' && <>
            {recovery?.retryAt && <p>Следующая попытка через {Math.max(0, Math.ceil((recovery.retryAt - Date.now()) / 1000))} с.</p>}
            {recovery?.phase === 'waiting' && <button onClick={() => { void entryOwner.current?.restart(); }}>Повторить</button>}
          </>}
        </li>)}</ul>}
      </>}
  </section>;
}
