import { test, expect } from '@playwright/test';
import { sample, withPlaybackPair } from './playback-fixture';
import { addChapters } from '../player/chapter-fixture';

test('главы мышью и Ctrl/Option: одна revision, оба участника без отката и эха', async () => {
  await withPlaybackPair(async ({ a, b, room }) => {
    await addChapters(b);
    let revision = 0;
    for (const action of ['click', 'Control+ArrowRight', 'Alt+ArrowLeft', 'timestamp', 'Enter', 'Space']) {
      if (action === 'click') await b.getByText('Chapter 16', { exact: true }).click();
      else if (action === 'timestamp') await b.getByText('0:24', { exact: true }).click();
      else if (['Enter', 'Space'].includes(action)) await b.getByRole('button', { name: action === 'Enter' ? 'Chapter 8' : 'Chapter 16', exact: true }).press(action);
      else { await b.locator('#movie_player').focus(); await b.keyboard.press(action); }
      const positionSeconds = ['Control+ArrowRight', 'timestamp'].includes(action) ? 24 : action === 'Enter' ? 8 : 16;
      revision++;
      await expect.poll(async () => (await room()).playback.revision).toBe(revision);
      for (const page of [a, b]) await expect.poll(() => sample(page)).toMatchObject({ positionSeconds, playbackRate: 1, isPlaying: false });
      await b.waitForTimeout(400);
      expect((await room()).playback.revision).toBe(revision);
    }
  });
});
