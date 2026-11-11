import type { Page } from '@playwright/test';

/** YouTube-shaped chapter controls outside the player, with real media seeking. */
export async function addChapters(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector('#movie_player')!;
    const video = document.querySelector('video')!;
    const panel = document.createElement('ytd-macro-markers-list-renderer');
    panel.style.cssText = 'display:block;position:relative;margin-top:400px';
    panel.innerHTML = [8, 16, 24].map(time => `<ytd-macro-markers-list-item-renderer>
      <button data-time="${time}"><span>Chapter ${time}</span></button>
    </ytd-macro-markers-list-item-renderer>`).join('');
    document.body.append(panel);
    const metadata = document.createElement('ytd-watch-metadata');
    metadata.style.display = 'block';
    metadata.innerHTML = `<div id="description"><a href="/watch?v=aqz-KE-bpKQ&t=24s">0:24</a>
      <a href="/watch?v=dQw4w9WgXcQ&t=8s">Other video</a></div>`;
    document.body.append(metadata);
    for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) button.onclick = () => {
      video.currentTime = Number(button.dataset.time);
    };
    panel.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (['Enter', ' '].includes(key.key)) {
        key.preventDefault(); key.stopPropagation();
        (key.target as HTMLElement).closest('button')?.click();
      }
    });
    for (const link of metadata.querySelectorAll<HTMLAnchorElement>('a')) link.onclick = event => {
      event.preventDefault();
      if (link.textContent === '0:24') video.currentTime = 24;
    };
    root.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if ((key.ctrlKey !== key.altKey) && !key.metaKey && !key.shiftKey
        && ['ArrowLeft', 'ArrowRight'].includes(key.key)) {
        key.preventDefault(); key.stopPropagation();
        video.currentTime = key.key === 'ArrowRight'
          ? [8, 16, 24].find(time => time > video.currentTime + 0.1) ?? 24
          : [24, 16, 8, 0].find(time => time < video.currentTime - 0.1) ?? 0;
      }
    });
  });
}
