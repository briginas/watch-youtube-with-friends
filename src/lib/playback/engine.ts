import { createPlaybackCommand, type CommandResult, type PlaybackCommand } from './commands';
import { playbackSchema, targetPositionSeconds, type Playback } from './model';
import type { ApplyResult, PlaybackSample, PlayerIntent, PlayerStatus } from '../player/youtube-player';

/** Порядок версий и команд не зависит от DOM, browser API и Firebase. */
export function createSyncEngine(options: {
  apply: (videoId: string, sample: PlaybackSample) => Promise<ApplyResult>;
  stop: () => void;
  sendCommand: (command: PlaybackCommand) => Promise<CommandResult>;
  now?: () => number;
  onError?: (message: string | null) => void;
}) {
  let latest: Playback | null = null;
  let connected = false;
  let offset = 0;
  let generation = 0;
  let disposed = false;
  let sending: PlaybackCommand | null = null;
  let applying = 0;
  let inFlight = false;
  let queued: PlaybackCommand | null = null;
  let interacting = false;
  let lastLocalActionAt = 0;
  let needsApply = false;
  let playerState: PlayerStatus = 'ready';
  let localSeek = false;
  let readiness = 0;

  function applyLatest() {
    if (disposed || !connected || !latest) return;
    if (playerState !== 'ready') { needsApply = true; return; }
    if (interacting || (queued && queued.actionAt > latest.actionAt)
      || (sending && sending.actionAt > latest.actionAt)) {
      needsApply = true;
      return;
    }
    const operation = ++applying;
    inFlight = true;
    const session = generation;
    const startedReady = readiness;
    needsApply = false;
    const state = latest;
    void options.apply(state.videoId, {
      positionSeconds: targetPositionSeconds(state, {
        nowMs: (options.now ?? Date.now)(), serverTimeOffsetMs: offset,
      }),
      playbackRate: state.playbackRate, isPlaying: state.isPlaying,
    }).then(result => {
      if (disposed || generation !== session || operation !== applying) return;
      inFlight = false;
      // Успех уже включает восстановление готовности и устойчивое совпадение.
      // Его собственный waiting → ready не должен запускать следующий seek.
      // Новая revision и ограничение после завершения требуют отдельного apply.
      if (result === 'applied' && !sending && playerState === 'ready' && latest?.revision === state.revision) needsApply = false;
      needsApply ||= result === 'blocked' || result === 'replaced' || result === 'timeout' || result === 'interrupted';
      // ready может прийти по bridge раньше ответа на заблокированное apply.
      if (needsApply && readiness !== startedReady && !sending) applyLatest();
    }, () => {
      if (disposed || generation !== session || operation !== applying) return;
      inFlight = false;
      needsApply = true;
      options.onError?.('Не удалось применить состояние к плееру.');
      if (readiness !== startedReady && !sending) applyLatest();
    });
  }

  function accept(state: Playback) {
    if (latest && state.revision <= latest.revision) return;
    if (latest && latest.videoRevision !== state.videoRevision) {
      generation++;
      sending = null;
      queued = null;
      interacting = false;
      applying++;
      inFlight = false;
      playerState = 'ready';
      localSeek = false;
      needsApply = true;
      options.stop();
    }
    latest = state;
    if (queued && queued.actionAt <= state.actionAt) queued = null;
    // Подтверждение собственного действия уже отражено в локальном плеере.
    if (state.commandId !== sending?.commandId) applyLatest();
  }

  async function send(command: PlaybackCommand): Promise<void> {
    const session = generation;
    sending = command;
    options.onError?.(null);
    try {
      const result = await options.sendCommand(command);
      if (disposed || session !== generation) return;
      if (result.playback) accept(result.playback);
      if (result.status === 'rejected') needsApply = true;
    } catch {
      if (disposed || session !== generation) return;
      options.onError?.('Не удалось отправить действие. Повторите попытку.');
      needsApply = true;
    } finally {
      if (sending === command) {
        sending = null;
        if (!interacting && queued) {
          const next = queued;
          queued = null;
          if (connected && latest && next.actionAt > latest.actionAt
            && (playerState === 'ready' || localSeek)) await send(next);
          else needsApply = true;
        }
        if (needsApply && playerState === 'ready' && !inFlight && !sending && !interacting) applyLatest();
      }
    }
  }

  return {
    update(input: { playback: unknown; connected: boolean; serverTimeOffset: number }) {
      if (disposed) return;
      offset = input.serverTimeOffset;
      const parsed = playbackSchema.safeParse(input.playback);
      const wasConnected = connected;
      connected = input.connected;
      if (wasConnected && !connected) {
        // Ответ записи из прошлого соединения больше не управляет плеером.
        generation++;
        sending = null;
        queued = null;
        interacting = false;
        applying++;
        inFlight = false;
        needsApply = true;
        playerState = 'ready';
        localSeek = false;
        options.stop();
        options.onError?.(null);
      }
      if (!parsed.success) {
        if (latest) {
          generation++;
          latest = null;
          sending = null;
          queued = null;
          interacting = false;
          applying++;
          inFlight = false;
          needsApply = false;
          playerState = 'ready';
          localSeek = false;
          options.stop();
        }
        return;
      }
      const previous = latest;
      accept(parsed.data);
      if (!wasConnected && connected) options.onError?.(null);
      if (!wasConnected && connected && previous && latest?.revision === previous.revision) applyLatest();
    },
    playerStatus(status: PlayerStatus, seeking = false) {
      if (disposed || !latest) return;
      if (status === 'ready' && playerState !== 'ready') readiness++;
      playerState = status;
      localSeek = status === 'buffering' && seeking;
      // Буферизация от своего seek не отменяет ожидающее debounce намерение.
      if (status !== 'ready' && !localSeek) {
        needsApply = true;
        queued = null;
        interacting = false;
      }
      if (status === 'ready' && needsApply && !inFlight && !sending) applyLatest();
    },
    playerInteraction(active: boolean) {
      if (disposed || !connected || !latest) return;
      if (active && !interacting) {
        applying++;
        inFlight = false;
      }
      interacting = active;
      needsApply = true;
      if (!active) {
        queued = null;
        if (!sending && !inFlight) applyLatest();
      }
    },
    async intent(intent: PlayerIntent) {
      if (disposed || !connected || !latest) return;
      interacting = false;
      if (playerState !== 'ready' && !(localSeek && intent.kind === 'seek')) return;
      needsApply = localSeek;
      // Метки фиксируются до ожидания записи, offset не применяется повторно.
      const actionAt = Math.max(intent.actionAt + offset, lastLocalActionAt + 0.001);
      lastLocalActionAt = actionAt;
      const command = createPlaybackCommand({ videoId: latest.videoId, ...intent.sample }, latest.revision, {
        actionAt, sampledAt: Math.max(intent.sampledAt + offset, actionAt),
      }, latest.videoRevision);
      if (command.actionAt <= latest.actionAt) {
        queued = null;
        applyLatest();
        return;
      }
      if (sending) { queued = command; return; }
      queued = null;
      await send(command);
    },
    dispose() {
      disposed = true;
      generation++;
      latest = null;
      queued = null;
      interacting = false;
      options.stop();
    },
  };
}
