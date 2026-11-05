import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';

test('unpacked MV3 загружается и открывает React popup', async ({ page, extensionId }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 336, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const heading = page.getByRole('heading', { name: 'Смотреть вместе', exact: true });
  await expect(heading).toBeVisible();
  const manifest = JSON.parse(readFileSync('.output/chrome-mv3/manifest.json', 'utf8'));
  const version = page.locator('header').getByText(`v${manifest.version}`, { exact: true });
  await expect(version).toBeVisible();
  const titleBox = (await heading.boundingBox())!;
  const versionBox = (await version.boundingBox())!;
  expect(versionBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(versionBox.y).toBeLessThan(titleBox.y + titleBox.height);
  expect(versionBox.x + versionBox.width).toBeLessThanOrEqual(336);
  await expect(page.getByRole('heading', { name: 'Мои комнаты' })).toBeVisible();
  await expect(page.getByText('Технический прототип')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Смотреть вместе', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Откройте обычное видео на YouTube.');
  expect(errors).toEqual([]);
});

test('Chrome показывает метку локальной сборки', async ({ page, extensionId }) => {
  const manifest = JSON.parse(readFileSync('.output/chrome-mv3/manifest.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.version_name).toMatch(/ dev · (?:[a-f0-9]{8,}(?: dirty)?|no-git) · \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  await page.goto(`chrome://extensions/?id=${extensionId}`);
  const details = page.locator('extensions-detail-view');
  await expect(details.getByText(manifest.version_name, { exact: true })).toBeVisible();
});
