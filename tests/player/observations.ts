import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Page, TestInfo, Worker } from '@playwright/test';
import { readProbe } from './fixtures';

export async function saveObservation(page: Page, worker: Worker, testInfo: TestInfo, observations: Record<string, unknown>) {
  const output = testInfo.outputPath('youtube-lifecycle.json');
  await mkdir(dirname(output), { recursive: true });
  const report = await readProbe(worker, page).catch(() => null);
  const documentState = await page.evaluate(() => {
    const root = document.querySelector('#movie_player');
    const video = root?.querySelector('video');
    return {
      url: location.href, userAgent: navigator.userAgent,
      activation: navigator.userActivation.hasBeenActive,
      rootClass: root?.className, videoPresent: !!video,
      readyState: video?.readyState, mediaError: video?.error?.code,
      playerText: root?.textContent?.slice(0, 1000),
    };
  }).catch(() => null);
  await writeFile(output, JSON.stringify({ observations, report, document: documentState }, null, 2));
  await testInfo.attach('youtube-lifecycle.json', { path: output, contentType: 'application/json' });
}

