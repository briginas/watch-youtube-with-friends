import type { BrowserContext, Page } from '@playwright/test';

/** Bounded media diagnostics; never retain request URLs, room keys or auth data. */
export async function observeMedia(context: BrowserContext) {
  const events: Record<string, unknown>[] = [];
  const pages = new Map<Page, number>();
  const append = (event: Record<string, unknown>) => {
    if (events.length === 500) events.shift();
    events.push({ at: Date.now(), ...event });
  };
  const attach = async (page: Page) => {
    const client = await context.newCDPSession(page);
    await client.send('Media.enable');
    client.on('Media.playerEventsAdded', ({ events: changes }) => {
      for (const change of changes) {
        // Values may contain signed media URLs; retain only names and enum states.
        try {
          const value = JSON.parse(change.value);
          const details = Object.fromEntries(['pipeline_state', 'state', 'reason'].flatMap(key =>
            typeof value[key] === 'string' && /^[\w .-]{1,100}$/.test(value[key]) ? [[key, value[key]]] : []));
          append({ page: pages.get(page), type: 'media', event: value.event, ...details });
        } catch { /* non-JSON event */ }
      }
    });
    client.on('Media.playerErrorsRaised', ({ errors }) => {
      for (const error of errors) append({ page: pages.get(page), type: 'media-error', code: error.code, group: error.errorType });
    });
    page.on('requestfailed', request => {
      const host = new URL(request.url()).hostname;
      if (host.endsWith('.googlevideo.com')) append({ page: pages.get(page), type: 'media-network', error: request.failure()?.errorText });
    });
  };
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.hostname.endsWith('.googlevideo.com') && response.status() >= 400) {
      append({ page: pages.get(response.frame().page()), type: 'media-http', status: response.status() });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/youtubei/v1/player') {
      void response.json().then(body => {
        const status = body.playabilityStatus;
        if (status) append({ page: pages.get(response.frame().page()), type: 'youtube-response', status: status.status, reason: status.reason });
      }).catch(() => {});
    }
  });
  context.on('page', page => {
    pages.set(page, pages.size);
    void attach(page).catch(() => append({ page: pages.get(page), type: 'diagnostic-unavailable' }));
  });
  await context.exposeBinding('__recordMediaDiagnostic', ({ page }, event: Record<string, unknown>) => append({ ...event, page: pages.get(page) }));
  await context.addInitScript(() => {
    const record = (event: unknown) => {
      void (window as unknown as { __recordMediaDiagnostic(event: unknown): Promise<void> }).__recordMediaDiagnostic(event).catch(() => {});
    };
    for (const name of ['loadstart', 'emptied', 'abort', 'error', 'loadedmetadata', 'waiting', 'playing', 'pause', 'ratechange', 'seeking']) {
      document.addEventListener(name, event => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || !video.matches('.html5-main-video')) return;
        record({
          type: 'dom', event: name, readyState: video.readyState, networkState: video.networkState,
          position: video.currentTime, paused: video.paused, rate: video.playbackRate,
          errorCode: video.error?.code ?? null,
        });
      }, true);
    }
  });
  return events;
}
