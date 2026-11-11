import { test, expect, openFixture, probe, readProbe } from './fixtures';
import { addChapters } from './chapter-fixture';

for (const action of ['click', 'Enter', 'Space', 'timestamp', 'Control+ArrowRight', 'Alt+ArrowRight', 'Control+ArrowLeft', 'Alt+ArrowLeft']) {
  test(`глава ${action}: один seek с сохранением состояния`, async ({ page, worker }) => {
    await openFixture(page, worker);
    await addChapters(page);
    expect(await probe(worker, page, 'apply', { positionSeconds: 12, playbackRate: 1.5, isPlaying: false })).toBe('applied');
    await probe(worker, page, 'clear');
    if (action === 'click') await page.getByText('Chapter 16', { exact: true }).click();
    else if (action === 'timestamp') await page.getByText('0:24', { exact: true }).click();
    else if (['Enter', 'Space'].includes(action)) await page.getByRole('button', { name: 'Chapter 16', exact: true }).press(action);
    else { await page.locator('#movie_player').focus(); await page.keyboard.press(action); }
    const positionSeconds = action === 'timestamp' ? 24 : action.endsWith('Left') ? 8 : 16;
    await expect.poll(async () => (await readProbe(worker, page)).intents).toEqual([
      expect.objectContaining({ kind: 'seek', sample: { positionSeconds, playbackRate: 1.5, isPlaying: false } }),
    ]);
    await page.waitForTimeout(300);
    expect((await readProbe(worker, page)).intents).toHaveLength(1);
  });
}

test('удержание chapter shortcut защищено от remote apply и объединяет повторы', async ({ page, worker }) => {
  await openFixture(page, worker);
  await addChapters(page);
  await page.locator('#movie_player').focus();
  await page.keyboard.down('Alt');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(300);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  expect(await probe(worker, page, 'apply', { positionSeconds: 2, playbackRate: 1, isPlaying: false })).toBe('interrupted');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('Alt'); // Modifier may be released before the arrow.
  await page.keyboard.up('ArrowRight');
  await expect.poll(async () => (await readProbe(worker, page)).intents).toEqual([
    expect.objectContaining({ kind: 'seek', sample: { positionSeconds: 16, playbackRate: 1, isPlaying: false } }),
  ]);
});

test('chapter pointerdown защищает до click; без media seek команда не возникает', async ({ page, worker }) => {
  await openFixture(page, worker);
  await addChapters(page);
  const box = (await page.getByText('Chapter 16', { exact: true }).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  expect(await probe(worker, page, 'apply', { positionSeconds: 2, playbackRate: 1, isPlaying: false })).toBe('interrupted');
  await page.mouse.up();
  await expect.poll(async () => (await readProbe(worker, page)).intents).toHaveLength(1);
  await probe(worker, page, 'clear');
  await page.getByRole('link', { name: 'Other video' }).click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 3; });
  await page.waitForTimeout(250);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  await page.getByRole('button', { name: 'Chapter 8', exact: true }).evaluate(button => { (button as HTMLButtonElement).onclick = null; });
  await page.getByRole('button', { name: 'Chapter 8', exact: true }).click();
  await page.waitForTimeout(1600);
  expect((await readProbe(worker, page)).intents).toEqual([]);
  expect((await readProbe(worker, page)).interactions.at(-1)).toBe(false);
});

test('chapter shortcuts в текстовом поле и смешанные модификаторы не разрешают seek', async ({ page, worker }) => {
  await openFixture(page, worker);
  await addChapters(page);
  for (const shortcut of ['Control+ArrowRight', 'Alt+ArrowRight']) {
    await page.getByRole('textbox', { name: 'Search' }).press(shortcut);
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime += 1; });
    await page.waitForTimeout(200);
  }
  await page.locator('#movie_player').focus();
  await page.keyboard.press('Control+Alt+ArrowRight');
  await page.keyboard.press('Control+Shift+ArrowRight');
  await page.waitForTimeout(200);
  expect((await readProbe(worker, page)).intents).toEqual([]);
});
