import { getWatchVideoId } from '../youtube-url';
import { setPlayerRate } from './rate-bridge';

export type PlaybackSample = {
  positionSeconds: number;
  playbackRate: number;
  isPlaying: boolean;
};
export type PlayerStatus = 'ready' | 'missing' | 'loading' | 'buffering' | 'ad'
  | 'unavailable' | 'unsupported' | 'different-video' | 'autoplay-blocked';
export type PlayerIntent = {
  kind: 'play' | 'pause' | 'seek' | 'rate'; sample: PlaybackSample;
  actionAt: number; sampledAt: number;
};
export type ApplyResult = 'applied' | 'blocked' | 'interrupted' | 'replaced' | 'timeout' | 'disposed';
export type PlayerTrace = { event: string; status: PlayerStatus; trusted?: boolean; detail?: string };

type Gesture = { kind: PlayerIntent['kind']; at: number; actionAt: number; seeking: boolean };
type PendingApply = {
  target: PlaybackSample;
  started: number;
  stableAt: number | null;
  resolve: (result: ApplyResult) => void;
};
const MEDIA_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting',
  'playing', 'canplay', 'loadedmetadata', 'durationchange', 'emptied', 'error', 'ended'] as const;
const RATE_CONTROLS = '.ytp-variable-speed-panel-button, .ytp-speedslider';
const SEEK_CONTROLS = '.ytp-progress-bar, .ytp-scrubber-container';
const PLAY_CONTROLS = '.ytp-play-button, .ytp-large-play-button, video.html5-main-video';
const LOCAL_CONTROLS = '.ytp-volume-area, .ytp-volume-panel, .ytp-mute-button, .ytp-subtitles-button, .ytp-quality-menu, .ytp-subtitles-menu';

/** Isolated DOM adapter with a narrow MAIN-world rate setter; no room transport. */
export function createYouTubePlayerAdapter(options: {
  videoId: string;
  onIntent: (intent: PlayerIntent) => void;
  onInteraction?: (active: boolean) => void;
  onStatus?: (status: PlayerStatus, localSeek: boolean) => void;
  onTrace?: (trace: PlayerTrace) => void;
}) {
  let root: Element | null = null;
  let video: HTMLVideoElement | null = null;
  let status: PlayerStatus = 'missing';
  let waiting = false;
  let autoplayBlocked = false;
  let gesture: Gesture | null = null;
  let pointerHeld = false;
  const heldSeekKeys = new Set<string>();
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let gestureTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: PendingApply | null = null;
  let disposed = false;

  const sample = (): PlaybackSample | null => video ? ({
    positionSeconds: video.currentTime,
    playbackRate: video.playbackRate,
    isPlaying: !video.paused && !video.ended,
  }) : null;

  function trace(event: string, detail?: string, trusted?: boolean) {
    options.onTrace?.({ event, status, detail, trusted });
  }
  function clearGesture(notify = true) {
    const active = !!gesture;
    gesture = null;
    pointerHeld = false;
    heldSeekKeys.clear();
    clearTimeout(seekTimer);
    clearTimeout(gestureTimer);
    if (active && notify) options.onInteraction?.(false);
  }
  function expireGesture() {
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(() => {
      if (!pointerHeld && !heldSeekKeys.size && !(gesture?.kind === 'seek' && gesture.seeking)) clearGesture();
    }, 1500);
  }
  function finishApply(result: ApplyResult) {
    const operation = pending;
    pending = null;
    if (operation) {
      trace('apply', result);
      operation.resolve(result);
    }
  }
  function readStatus(): PlayerStatus {
    if (getWatchVideoId(location.href) !== options.videoId) return 'different-video';
    // Some unavailable watch pages hide the player and render a separate promo.
    // YouTube also keeps hidden error templates on playable pages.
    const pageError = [...document.querySelectorAll(
      'ytd-watch-flexy yt-playability-error-supported-renderers, ytd-watch-flexy ytd-background-promo-renderer, #movie_player .ytp-error-content-wrap',
    )].some(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    });
    if (pageError) return 'unavailable';
    if (!root) return 'missing';
    if (root.matches('.ad-showing, .ad-interrupting')) return 'ad';
    if (video?.error || root.classList.contains('ytp-error')) return 'unavailable';
    if (!video) return 'missing';
    if (autoplayBlocked) return 'autoplay-blocked';
    if (video.readyState === 0 || Number.isNaN(video.duration)) return 'loading';
    if (!Number.isFinite(video.duration)) return 'unsupported';
    if (waiting || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return 'buffering';
    return 'ready';
  }
  function updateStatus() {
    const next = readStatus();
    if (status !== next) {
      status = next;
      // A seek started on a ready player may itself cause buffering.
      if (next !== 'ready' && !(next === 'buffering' && gesture?.kind === 'seek')) clearGesture();
      if (['different-video', 'unavailable', 'ad', 'autoplay-blocked'].includes(next)) finishApply('blocked');
      trace('status');
      options.onStatus?.(status, next === 'buffering' && gesture?.kind === 'seek');
    }
    return status;
  }
  function emit(kind: PlayerIntent['kind']) {
    const current = sample();
    const localStatus = updateStatus();
    if (!current || pending || !gesture || gesture.kind !== kind
      || (kind !== 'seek' && performance.now() - gesture.at > 1500)
      || (kind === 'seek' && (pointerHeld || heldSeekKeys.size || video?.seeking))
      || (localStatus !== 'ready' && !(kind === 'seek' && localStatus === 'buffering'))) return;
    const actionAt = gesture.actionAt;
    clearGesture(false); // Intent завершает interaction без промежуточного remote apply.
    trace('intent', kind);
    options.onIntent({ kind, sample: current, actionAt, sampledAt: Date.now() });
  }
  function flushSeek() {
    clearTimeout(seekTimer);
    if (gesture?.kind === 'seek' && gesture.seeking && !pointerHeld && !heldSeekKeys.size) {
      seekTimer = setTimeout(() => emit('seek'), 120);
    }
  }
  function onMedia(event: Event) {
    if (event.currentTarget !== video) return;
    if (event.type === 'waiting') waiting = true;
    if (event.type === 'playing' || event.type === 'emptied') autoplayBlocked = false;
    if (['playing', 'canplay', 'loadedmetadata', 'emptied'].includes(event.type)) waiting = false;
    if (event.type === 'emptied' || event.type === 'error') {
      clearGesture();
      finishApply('replaced');
    }
    updateStatus();
    trace(event.type, pending ? 'remote' : gesture?.kind ?? 'system', event.isTrusted);
    if (pending) return;
    if (event.type === 'seeking' && gesture?.kind === 'seek') {
      gesture.seeking = true;
      flushSeek();
    } else if (event.type === 'seeked') flushSeek();
    else if (event.type === 'play' && video && !video.paused) emit('play');
    else if (event.type === 'pause' && video?.paused) emit('pause');
    else if (event.type === 'ratechange') emit('rate');
  }
  function checkApply() {
    if (!pending || !video) return;
    const now = performance.now();
    if (now - pending.started > 3000) return finishApply('timeout');
    const target = pending.target;
    const expectedPosition = target.positionSeconds + (target.isPlaying ? (now - pending.started) / 1000 * target.playbackRate : 0);
    const reached = status === 'ready' && !video.seeking
      && video.paused === !target.isPlaying && Math.abs(video.playbackRate - target.playbackRate) < 0.01
      && Math.abs(video.currentTime - expectedPosition) < 0.5;
    if (!reached) pending.stableAt = null;
    else if (pending.stableAt === null) pending.stableAt = now;
    else if (now - pending.stableAt >= 100) finishApply('applied');
  }
  const rootObserver = new MutationObserver(() => refresh());
  function refresh() {
    if (disposed) return;
    const nextRoot = document.querySelector('#movie_player');
    const nextVideo = nextRoot?.querySelector<HTMLVideoElement>('video.html5-main-video') ?? null;
    if (nextRoot !== root || nextVideo !== video) {
      for (const name of MEDIA_EVENTS) video?.removeEventListener(name, onMedia);
      rootObserver.disconnect();
      clearGesture();
      finishApply('replaced');
      root = nextRoot;
      video = nextVideo;
      waiting = false;
      autoplayBlocked = false;
      for (const name of MEDIA_EVENTS) video?.addEventListener(name, onMedia);
      if (root) rootObserver.observe(root, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
      trace('binding', video ? 'attached' : 'detached');
    }
    updateStatus();
    checkApply();
  }
  function rateMenu(target: Element) {
    const menu = target.closest('.ytp-panel-menu');
    return !!target.closest('[role="menuitemradio"]') && !!menu
      && [...menu.querySelectorAll('.ytp-menuitem-label')].filter(item => /^(?:0\.\d+|[1-4](?:\.\d+)?)$/.test(item.textContent?.trim() ?? '')).length >= 3;
  }
  function chapterControl(target: Element) {
    if (target.closest('ytd-macro-markers-list-item-renderer')) return true;
    const link = target.closest<HTMLAnchorElement>('ytd-watch-metadata #description a[href]');
    if (!link) return false;
    try {
      const url = new URL(link.href, location.href);
      const time = url.searchParams.get('t') ?? url.searchParams.get('start');
      return url.origin === location.origin && getWatchVideoId(url.href) === options.videoId
        && !!time && /^(?:\d+|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/.test(time);
    } catch {
      return false;
    }
  }
  function onInput(event: Event) {
    if (!event.isTrusted || disposed) return;
    refresh();
    const target = event.target instanceof Element ? event.target : null;
    // Arrow/Space на личных контролах не разрешают последующие системные
    // seek/play/pause и не прерывают применение состояния комнаты.
    const personalSettings = target?.closest('.ytp-settings-menu')
      && !target.closest(RATE_CONTROLS) && !rateMenu(target);
    if (target?.closest(LOCAL_CONTROLS) || personalSettings) {
      clearGesture();
      return;
    }
    if (!target || target.closest('textarea, [contenteditable]:not([contenteditable="false"])')
      || (target.closest('input') && !target.matches('.ytp-speedslider'))) return;
    const chapter = chapterControl(target);
    let kind: PlayerIntent['kind'] | null = null;
    if (event instanceof KeyboardEvent) {
      // YouTube chapters: Ctrl+Arrow on Windows, Option+Arrow on macOS.
      // Other modified shortcuts must not authorize subsequent media events.
      const chapterShortcut = root?.contains(target) && ['ArrowLeft', 'ArrowRight'].includes(event.key)
        && event.ctrlKey !== event.altKey && !event.metaKey && !event.shiftKey;
      if (chapterShortcut) kind = 'seek';
      else if (event.ctrlKey || event.altKey || event.metaKey) return;
      else if (chapter && ['Enter', ' '].includes(event.key)) kind = 'seek';
      else if (root?.contains(target) && target.closest(RATE_CONTROLS)
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) kind = 'rate';
      else if (['k', 'K', 'MediaPlayPause'].includes(event.key)
        || (event.key === ' ' && root?.contains(target))) kind = video?.paused ? 'play' : 'pause';
      else if (['j', 'J', 'l', 'L'].includes(event.key)
        || (root?.contains(target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End', ...'0123456789'].includes(event.key))) kind = 'seek';
      // YouTube also handles the physical shortcut in non-Latin layouts (Б/Ю).
      // The gesture only permits a command; ratechange must still confirm it.
      else if (['<', '>'].includes(event.key)
        || (event.shiftKey && ['Comma', 'Period'].includes(event.code))) kind = 'rate';
      else if (root?.contains(target) && ['Enter', ' '].includes(event.key)) {
        if (target.closest(PLAY_CONTROLS)) kind = video?.paused ? 'play' : 'pause';
        else if (target.closest(RATE_CONTROLS) || rateMenu(target)) kind = 'rate';
      }
    } else if (chapter && ['pointerdown', 'click'].includes(event.type)) kind = 'seek';
    else if (root?.contains(target)) {
      if (target.closest(PLAY_CONTROLS)) kind = video?.paused ? 'play' : 'pause';
      else if (target.closest(SEEK_CONTROLS)) kind = 'seek';
      else if (target.closest(RATE_CONTROLS) || rateMenu(target)) kind = 'rate';
    }
    if (!kind) return;
    const continuingSeek = kind === 'seek' && gesture?.kind === 'seek';
    const inputStatus = updateStatus();
    if (inputStatus !== 'ready' && !(continuingSeek && inputStatus === 'buffering')) return;
    if (gesture?.kind === kind && performance.now() - gesture.at < 1500 && event.type === 'click') return;
    if (!continuingSeek) clearGesture(false);
    else clearTimeout(seekTimer);
    finishApply('interrupted');
    autoplayBlocked = false;
    gesture = { kind, at: performance.now(), actionAt: Date.now(), seeking: continuingSeek && !!gesture?.seeking };
    if (kind === 'seek') {
      if (event instanceof KeyboardEvent) heldSeekKeys.add(event.code || event.key);
      else if (event.type === 'pointerdown') pointerHeld = true;
    }
    expireGesture();
    options.onInteraction?.(true);
    trace('input', kind, true);
  }
  function onRelease(event: Event) {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent) {
      if (!heldSeekKeys.delete(event.code || event.key)) return;
    } else {
      if (!pointerHeld) return;
      pointerHeld = false;
    }
    if (gesture) {
      gesture.at = performance.now();
      gesture.actionAt = Date.now();
      expireGesture();
    }
    flushSeek();
  }
  function onBlur() { clearGesture(); }
  for (const name of ['pointerdown', 'click', 'keydown', 'input']) document.addEventListener(name, onInput, true);
  document.addEventListener('pointerup', onRelease, true);
  document.addEventListener('keyup', onRelease, true);
  document.addEventListener('pointercancel', onBlur, true);
  window.addEventListener('blur', onBlur);
  // Poll also covers a replaced root and history changes without YouTube-private APIs.
  const timer = setInterval(refresh, 100);
  refresh();

  return {
    read() { refresh(); return { status, sample: sample() }; },
    apply(target: PlaybackSample): Promise<ApplyResult> {
      if (disposed) return Promise.resolve('disposed');
      if (!Number.isFinite(target.positionSeconds) || target.positionSeconds < 0
        || !Number.isFinite(target.playbackRate) || target.playbackRate < 0.25 || target.playbackRate > 16
        || typeof target.isPlaying !== 'boolean') throw new TypeError('Invalid playback target');
      refresh();
      // Защита от гонки: interaction message мог ещё не дойти до session.
      if (gesture) return Promise.resolve('interrupted');
      finishApply('interrupted');
      if (!video || status !== 'ready') return Promise.resolve('blocked');
      const element = video;
      const bounded = { ...target, positionSeconds: Math.min(target.positionSeconds, Math.max(0, element.duration - 0.05)) };
      return new Promise(resolve => {
        const operation: PendingApply = { target: bounded, started: performance.now(), stableAt: null, resolve };
        pending = operation; // Before any setter: media events are asynchronous.
        trace('apply', 'started');
        try {
          if (!setPlayerRate(element, options.videoId, bounded.playbackRate)) {
            finishApply('blocked');
            return;
          }
          if (Math.abs(element.currentTime - bounded.positionSeconds) > 0.1) element.currentTime = bounded.positionSeconds;
          if (bounded.isPlaying) {
            void element.play().catch((error: unknown) => {
              if (pending !== operation) return;
              autoplayBlocked = error instanceof DOMException && error.name === 'NotAllowedError';
              trace('play-rejected', error instanceof Error ? error.name : 'unknown');
              updateStatus();
              finishApply('blocked');
            });
          } else element.pause();
        } catch {
          finishApply('blocked');
        }
      });
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      rootObserver.disconnect();
      clearGesture();
      finishApply('disposed');
      for (const name of MEDIA_EVENTS) video?.removeEventListener(name, onMedia);
      for (const name of ['pointerdown', 'click', 'keydown', 'input']) document.removeEventListener(name, onInput, true);
      document.removeEventListener('pointerup', onRelease, true);
      document.removeEventListener('keyup', onRelease, true);
      document.removeEventListener('pointercancel', onBlur, true);
      window.removeEventListener('blur', onBlur);
    },
  };
}
