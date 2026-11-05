import { z } from 'zod';
import { getWatchVideoId } from '../youtube-url';

const RATE_EVENT = 'watch-together:set-player-rate';

/** Synchronous DOM request; cancellation acknowledges the player's own rate.
 * No room identity, extension API, or asynchronous work crosses this boundary.
 */
export function setPlayerRate(video: HTMLVideoElement, videoId: string, playbackRate: number): boolean {
  return !video.dispatchEvent(new CustomEvent(RATE_EVENT, {
    detail: JSON.stringify({ videoId, playbackRate }), bubbles: true, cancelable: true,
  }));
}

/** Runs in MAIN world, where YouTube's methods on #movie_player are visible. */
export function installPlayerRateBridge() {
  const requestSchema = z.object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    playbackRate: z.number().min(0.25).max(16),
  }).strict();
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string' || event.detail.length > 256) return;
    try {
      const request = requestSchema.safeParse(JSON.parse(event.detail));
      if (!request.success || getWatchVideoId(location.href) !== request.data.videoId) return;
      const root = document.querySelector('#movie_player') as (HTMLElement & {
        setPlaybackRate?: (rate: number) => void;
        getPlaybackRate?: () => number;
        getVideoData?: () => { video_id?: string };
      }) | null;
      const video = root?.querySelector('video.html5-main-video');
      if (!(video instanceof HTMLVideoElement) || event.target !== video || video.readyState < 3
        || video.error || root?.matches('.ad-showing, .ad-interrupting, .ytp-error')
        || typeof root?.setPlaybackRate !== 'function' || typeof root.getPlaybackRate !== 'function'
        || (root.getVideoData && root.getVideoData().video_id !== request.data.videoId)) return;
      root.setPlaybackRate(request.data.playbackRate);
      // A native media setter leaves this value (and YouTube's controls) stale.
      if (Math.abs(root.getPlaybackRate() - request.data.playbackRate) < 0.01) event.preventDefault();
    } catch { /* Missing/changed player API leaves the request unacknowledged. */ }
  };
  document.addEventListener(RATE_EVENT, listener, true);
  return () => document.removeEventListener(RATE_EVENT, listener, true);
}
