import { backendGeneration } from '../../lib/firebase/config';
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { getWatchVideoId } from '../../lib/youtube-url';
import styles from './App.module.css';
import { firebaseConfig } from '../../lib/firebase/config';
import { authErrorMessage, closeFirebaseClient } from '../../lib/firebase/client';
import type { PopupSessionState } from '../../lib/room/messages';
import { initialPlaybackSchema } from '../../lib/room/creation';
import { connectionMessage } from '../../lib/room/status';
import { roomMetadataSchema } from '../../lib/room/metadata';
import { Catalog } from './Catalog';
import { abortable } from '../../lib/service-status';
import { generationBlocksEntry } from '../../lib/connection-error';
import { ThemeToggle } from './ThemeToggle';

type PageState = 'loading' | 'watch' | 'unsupported' | 'error';

export function App() {
  const [pageState, setPageState] = useState<PageState>('loading');
  const [connection, setConnection] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<{ target: string; tabId: number } | null>(null);
  const [transport, setTransport] = useState<PopupSessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{ invitation: string; copied: boolean } | null>(null);
  const invitationField = useRef<HTMLInputElement>(null);
  const invitation = transport?.roomInvitation ?? transport?.invitation;
  const copyFeedback = copyResult?.invitation === invitation ? copyResult : null;

  useEffect(() => {
    if (copyFeedback && !copyFeedback.copied) invitationField.current?.focus();
  }, [copyFeedback]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), 15_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFailed(false);
    setSession(null);
    setTransport(null);
    abortable(browser.tabs.query({ active: true, currentWindow: true }), controller.signal).then(
      async ([tab]) => {
        if (cancelled) return;
        const watch = !!getWatchVideoId(tab?.url);
        setPageState(watch ? 'watch' : 'unsupported');
        if (!watch) return;
        if (!firebaseConfig()) { setConnection('Подключение к серверу ещё не настроено.'); return; }
        setConnection('Подключаемся…');
        try {
          const { target } = await abortable(browser.tabs.sendMessage(tab!.id!, { type: 'room-session-ensure' }), controller.signal);
          if (typeof target !== 'string') throw new Error('session/unavailable');
          const poll = async () => {
            if (cancelled) return;
            try {
              const state: PopupSessionState = await abortable(browser.runtime.sendMessage({ type: 'room-session', backendGeneration, target, action: 'status' }), controller.signal);
              if (state?.phase && state.phase !== 'idle') {
                clearTimeout(deadlineTimer);
                setSession({ target, tabId: tab!.id! });
                setTransport(state); setConnection(connectionMessage(state));
                setFailed(state.phase === 'error');
                timer = setTimeout(() => { void poll(); }, 1_000);
                return;
              }
              controller.signal.throwIfAborted();
            } catch (error) {
              if (controller.signal.aborted) {
                if (!cancelled) { setConnection(authErrorMessage(error)); setFailed(true); }
                return;
              }
            }
            timer = setTimeout(() => { void poll(); }, 100);
          };
          if (attempt > 0) {
            await browser.runtime.sendMessage({ type: 'room-session', backendGeneration, target, action: 'retry' });
          }
          await poll();
        } catch (error) {
          if (!cancelled) { setConnection(authErrorMessage(error)); setFailed(true); }
        }
      },
      () => {
        if (!cancelled) { clearTimeout(deadlineTimer); setPageState('error'); }
      },
    );
    return () => { cancelled = true; controller.abort(); clearTimeout(deadlineTimer); clearTimeout(timer); };
  }, [attempt]);

  useEffect(() => {
    const close = () => { void closeFirebaseClient(); };
    addEventListener('pagehide', close);
    return () => removeEventListener('pagehide', close);
  }, []);

  async function createRoom() {
    if (!session || busy) return;
    setBusy(true);
    setActionError(null);
    setCopyResult(null);
    try {
      const snapshot = await browser.tabs.sendMessage(session.tabId, {
        type: 'room-player-snapshot', target: session.target,
      });
      if (snapshot?.error) throw new Error(snapshot.error);
      const playback = initialPlaybackSchema.safeParse(snapshot?.playback);
      const metadata = roomMetadataSchema.safeParse(snapshot?.metadata);
      if (!playback.success || !metadata.success) throw new Error('Не удалось прочитать состояние плеера. Повторите попытку.');
      const state: PopupSessionState = await browser.runtime.sendMessage({
        type: 'room-session', backendGeneration, target: session.target, action: 'create', playback: playback.data, metadata: metadata.data,
      });
      if (!state || !('phase' in state)) throw new Error('Не удалось создать комнату. Откройте расширение ещё раз.');
      setTransport(state);
      setConnection(connectionMessage(state));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Не удалось создать комнату. Повторите попытку.');
    } finally { setBusy(false); }
  }

  async function copyInvitation() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation);
      setCopyResult({ invitation, copied: true });
    } catch {
      setCopyResult({ invitation, copied: false });
    }
  }

  async function leaveRoom() {
    if (!session || busy) return;
    setBusy(true);
    setActionError(null);
    setCopyResult(null);
    try {
      const state: PopupSessionState = await browser.runtime.sendMessage({
        type: 'room-session', backendGeneration, target: session.target, action: 'unwatch',
      });
      if (!state || !('phase' in state)) throw new Error();
      setTransport(state);
      setConnection(connectionMessage(state));
    } catch { setActionError('Не удалось выйти из комнаты. Повторите попытку.'); }
    finally { setBusy(false); }
  }

  const message = {
    loading: 'Проверяем открытую вкладку…',
    watch: 'Видео YouTube открыто.',
    unsupported: 'Откройте обычное видео на YouTube.',
    error: 'Не удалось проверить вкладку. Откройте расширение ещё раз.',
  }[pageState];

  const hasRoom = !!(transport?.roomName || transport?.room || invitation);
  const roomReady = transport?.connected && transport.roomReady && !transport.error && !transport.roomError;
  const participants = roomReady && !transport?.presenceError ? transport?.participants : undefined;
  const hasProblem = !!(transport?.error || transport?.roomError || transport?.presenceError);
  let roomStatus = connection;
  if (roomReady && !hasProblem) roomStatus = 'Комната подключена.';
  else if (transport?.roomName && transport.connected && !hasProblem && transport.recovery?.phase !== 'stopped') {
    roomStatus = 'Получаем актуальное состояние комнаты…';
  }

  return (
    <main className={styles.panel}>
      <header className={styles.header}>
        <img className={styles.brandIcon} src="/icon/128.png" alt="" width="44" height="44" />
        <div className={styles.brandTitle}>
          <h1>Смотреть вместе</h1>
          <span className={styles.version}>v{browser.runtime.getManifest().version}</span>
        </div>
        <ThemeToggle />
      </header>
      <img className={styles.hero} src="/assets/popup-plush.webp" alt="" width="800" height="236" />
      <section className={styles.context} aria-label="Эта вкладка">
        {hasRoom ? <>
          <div className={styles.roomBar}>
            <span className={styles.dot} data-connected={roomReady || undefined} data-problem={hasProblem || undefined} aria-hidden="true" />
            <strong className={styles.roomName}>{transport?.roomName ?? 'Комната'}</strong>
            {participants && <span className={styles.count}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/></svg>
              <span><span className={styles.srOnly}>Участников: </span>{participants.length}</span>
            </span>}
          </div>
          <p role="status" className={styles.note}>{roomStatus}</p>
          <button type="button" className={styles.primary} aria-label="Копировать приглашение"
            disabled={!invitation || busy} onClick={() => { void copyInvitation(); }}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13.5a4 4 0 0 0 5.7 0l4.2-4.2a4 4 0 0 0-5.7-5.7l-2.4 2.4m2.2 4.5a4 4 0 0 0-5.7 0l-4.2 4.2a4 4 0 0 0 5.7 5.7l2.4-2.4"/></svg>
            Копировать приглашение
          </button>
          {copyFeedback && <p role="status" className={styles.note}>{copyFeedback.copied
            ? 'Приглашение скопировано.'
            : 'Не удалось скопировать приглашение. Скопируйте ссылку вручную.'}</p>}
          {copyFeedback?.copied === false && invitation && <label className={styles.invitation}>Ссылка-приглашение
            <input ref={invitationField} readOnly value={invitation} onFocus={(event) => event.target.select()} />
          </label>}
          <details className={styles.details}>
            <summary>Подробности комнаты</summary>
            {!!participants?.length && <ul aria-label="Участники">{participants.map(participant => <li key={participant.number}>
              <span className={styles.participantDot} style={{ backgroundColor: participant.color }} aria-hidden="true" />
              Участник {participant.number}{participant.isSelf ? ' (вы)' : ''}
            </li>)}</ul>}
            <button className={styles.leave} disabled={!session || busy} onClick={() => { void leaveRoom(); }}>Выйти из комнаты</button>
          </details>
        </> : <>
          <p role="status" className={styles.note}>{message}</p>
          {connection && <p aria-live="polite" className={styles.note}>{connection}</p>}
        </>}
        {failed && !generationBlocksEntry(transport?.recovery?.failure) && <button onClick={() => {
          if (session) void browser.runtime.sendMessage({ type: 'room-session', backendGeneration, target: session.target, action: 'retry' });
          setAttempt((value) => value + 1);
        }}>Повторить</button>}
        {session && ['running', 'waiting'].includes(transport?.recovery?.phase ?? '') && <button onClick={() => {
          void browser.runtime.sendMessage({ type: 'room-session', backendGeneration, target: session.target, action: 'stop' });
        }}>Остановить попытки</button>}
        {pageState === 'watch' && !hasRoom && <button className={styles.primary}
          disabled={!session || !transport?.connected || busy || transport.creating}
          onClick={() => { void createRoom(); }}
        >{busy || transport?.creating ? 'Создаём комнату…' : 'Смотреть вместе'}</button>}
        {(actionError || transport?.creationError) && <p role="alert">{actionError ?? transport?.creationError}</p>}
      </section>
      <Catalog />
    </main>
  );
}
