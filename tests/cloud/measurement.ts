import type { Page } from '@playwright/test';

export type Point = {
  at: number;
  position: number;
  rate: number;
  playing: boolean;
  ready: boolean;
  ad: boolean;
  buffering: boolean;
};
type Probe = { points: Point[]; inputAt: number | null; changed: Point | null; event: string; dispose(): void };
declare global { interface Window { __cloudMeasurement?: Probe } }

/** Только наблюдение DOM в тесте: не добавляет API или логирование в расширение. */
export async function arm(page: Page, event = '') {
  await page.evaluate(eventName => {
    window.__cloudMeasurement?.dispose();
    const video = document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video')!;
    const root = document.querySelector('#movie_player')!;
    const read = () => ({
      at: performance.timeOrigin + performance.now(), position: video.currentTime,
      rate: video.playbackRate, playing: !video.paused && !video.ended,
      ready: video.readyState >= 3 && !video.seeking && !video.error && !root.matches('.ad-showing, .ad-interrupting'),
      ad: root.matches('.ad-showing, .ad-interrupting'), buffering: video.readyState < 3,
    });
    const input = (event: Event) => {
      if (event.isTrusted && event.target instanceof Element && root.contains(event.target)) {
        probe.inputAt ??= performance.timeOrigin + performance.now();
      }
    };
    const media = () => { if (probe.inputAt !== null) probe.changed ??= read(); };
    const probe: Probe = {
      points: [], inputAt: null, changed: null, event: eventName,
      dispose() {
        clearInterval(timer);
        document.removeEventListener('keydown', input, true);
        document.removeEventListener('pointerdown', input, true);
        if (eventName) video.removeEventListener(eventName, media);
      },
    };
    const timer = setInterval(() => { if (probe.points.length < 6000) probe.points.push(read()); }, 10);
    document.addEventListener('keydown', input, true);
    document.addEventListener('pointerdown', input, true);
    if (eventName) video.addEventListener(eventName, media);
    window.__cloudMeasurement = probe;
  }, event);
}

export function applicationTime(points: Point[], inputAt: number, reference: Point) {
  let stableAt: number | null = null;
  let previousAt = inputAt;
  for (const point of points) {
    if (point.at < inputAt) continue;
    const expectedPosition = reference.position + (reference.playing ? (point.at - reference.at) / 1000 * reference.rate : 0);
    const reached = point.ready && point.playing === reference.playing && Math.abs(point.rate - reference.rate) < 0.01
      && Math.abs(point.position - expectedPosition) <= 0.5;
    if (!reached || point.at - previousAt > 100) stableAt = null;
    if (reached) {
      stableAt ??= point.at;
      if (point.at - stableAt >= 100) return point.at - inputAt;
    }
    previousAt = point.at;
  }
  return null;
}

export function percentile95(values: number[]) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]! : null;
}

export function positionDifference(a: Point, b: Point) {
  // Снимки сняты независимыми browser timers. Приводим к более позднему моменту.
  const at = Math.max(a.at, b.at);
  const position = (point: Point) => point.position + (point.playing ? (at - point.at) / 1000 * point.rate : 0);
  return Math.abs(position(a) - position(b));
}
