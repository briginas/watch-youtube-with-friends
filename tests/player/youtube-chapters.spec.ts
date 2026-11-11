import { test, expect, probe, readProbe } from './fixtures';
import { writeFile } from 'node:fs/promises';

test.use({ trace: 'off', actionTimeout: 10_000 });

test('реальный YouTube: глава мышью и Option+стрелка', async ({ page, worker }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoints: Record<string, unknown> = {};
  try {
    // Start next to the 2:21 chapter so both native actions use the initial media range.
    await page.goto('https://www.youtube.com/watch?v=nKjPBAw_N_0&t=137s&hl=en', { waitUntil: 'domcontentloaded' });
    const rejectCookies = page.locator('ytd-consent-bump-v2-lightbox').getByRole('button', { name: /Reject/ });
    const consentShown = await rejectCookies.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    if (consentShown) {
      await rejectCookies.click();
      await expect(page.locator('ytd-consent-bump-v2-lightbox')).toBeHidden();
    }
    await expect.poll(async () => (await readProbe(worker, page).catch(() => null))?.status, { timeout: 35_000 }).toBe('ready');
    // Settle initial autoplay before exercising native chapter controls.
    expect(await probe(worker, page, 'apply', { positionSeconds: 137, playbackRate: 1, isPlaying: false })).toBe('applied');
    checkpoints.initial = await readProbe(worker, page);
    checkpoints.chapters = await page.locator('.ytp-chapter-title').allTextContents();
    await page.locator('#movie_player').hover();
    const chapterTitle = page.locator('.ytp-chapter-title').first();
    await expect(chapterTitle).toBeEnabled({ timeout: 15_000 });
    await chapterTitle.click();
    const chapters = page.locator('ytd-macro-markers-list-item-renderer:visible');
    await expect(chapters.nth(2)).toBeVisible();
    checkpoints.chapterDOM = await chapters.nth(2).evaluate(element => element.outerHTML.slice(0, 5000));
    await probe(worker, page, 'clear');
    await page.locator('#movie_player').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+ArrowRight' : 'Control+ArrowRight');
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind), { timeout: 20_000 }).toEqual(['seek']);
    checkpoints.shortcut = await readProbe(worker, page);
    expect((await readProbe(worker, page)).intents[0]!.sample.positionSeconds).toBeCloseTo(141, 0);
    await expect.poll(async () => (await readProbe(worker, page)).status, { timeout: 20_000 }).toBe('ready');
    expect(await probe(worker, page, 'apply', { positionSeconds: 137, playbackRate: 1, isPlaying: false })).toBe('applied');
    await probe(worker, page, 'clear');
    await chapters.nth(2).click();
    await expect.poll(async () => (await readProbe(worker, page)).intents.map(i => i.kind), { timeout: 20_000 }).toEqual(['seek']);
    checkpoints.click = await readProbe(worker, page);
    expect((await readProbe(worker, page)).intents[0]!.sample.positionSeconds).toBeCloseTo(141, 0);
  } finally {
    checkpoints.final = await readProbe(worker, page).catch(() => null);
    checkpoints.title = await page.title().catch(() => null);
    checkpoints.dialogButtons = await page.locator('ytd-consent-bump-v2-lightbox button').evaluateAll(buttons =>
      buttons.map(button => ({ text: button.textContent, label: button.getAttribute('aria-label') }))).catch(() => null);
    await page.screenshot({ path: testInfo.outputPath('youtube-chapters.png'), timeout: 5000 }).catch(() => {});
    const path = testInfo.outputPath('youtube-chapters.json');
    await writeFile(path, JSON.stringify(checkpoints, null, 2));
    await testInfo.attach('youtube-chapters.json', { path, contentType: 'application/json' });
  }
});
