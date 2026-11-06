import { test, expect } from '@playwright/test';
import { frameOf, popup, setup } from './fixtures';

test('YouTube: первое подключение после настоящего SPA-перехода в двух новых вкладках', async ({}, testInfo) => {
  test.skip(process.env.YOUTUBE_TRANSPORT_REAL !== '1', 'Opt-in: требуется настоящий YouTube.');
  test.setTimeout(120_000);
  const { context, extensionId } = await setup(true);
  const observations: Record<string, unknown>[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const page = await context.newPage();
      await page.goto('https://www.youtube.com/results?search_query=big+buck+bunny+blender&hl=en', { waitUntil: 'domcontentloaded' });
      const link = page.locator('ytd-video-renderer a#video-title[href*="watch?v="]').first();
      await expect(link).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => { document.documentElement.dataset.sessionStartDocument = 'original'; });
      await link.click();
      await expect(page).toHaveURL(/\/watch\?v=/);
      await expect(page.locator('html')).toHaveAttribute('data-session-start-document', 'original');
      const control = await popup(context, page, extensionId);
      try {
        await expect.poll(() => control.evaluate<string>('document.body.textContent'))
          .toContain('Подключено. Комната ещё не выбрана.');
        expect(await control.evaluate<boolean>('[...document.querySelectorAll("button")].find(b => b.textContent === "Смотреть вместе").disabled')).toBe(false);
        await frameOf(page);
        const frames = page.frames().filter(f => f.url().includes('/session.html#'));
        expect(frames).toHaveLength(1);
        observations.push({ tab: index + 1, url: page.url(), sameDocument: true, connected: true, createEnabled: true, sessionFrames: frames.length });
      } finally { await control.close(); }
    }
  } finally {
    await testInfo.attach('youtube-session-start', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
    await context.close();
  }
});
