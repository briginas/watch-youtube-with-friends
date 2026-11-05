import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHosting } from '../../scripts/release/hosting.mjs';

test('без расширения: active/retired/unknown, privacy и HTTP без секретов', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage(); const requests = [];
    const headers = Object.fromEntries(JSON.parse(readFileSync('firebase.json', 'utf8')).hosting.headers[0].headers.map(item => [item.key, item.value]));
    let state = 'active';
    page.on('request', request => requests.push(request.url()));
    await page.route('https://control.example/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/backend-generations.json') return route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(state === 'unknown' ? {} : { schemaVersion: 1, revision: 1, updatedAt: '2020-01-01T00:00:00Z', generations: [
          { generation: 'g1', firstRelease: '0.1.0', state, ...(state === 'retired' ? { retiredAt: '2020-01-01T00:00:00Z' } : {}) }] }) });
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html', 'style.css', 'generation-status.js', 'privacy.html'].includes(name)) return route.abort();
      return route.fulfill({ headers, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(`firebase/hosting/${name}`, 'utf8') });
    });
    const secret = 'private-room-secret-'.repeat(3);
    for (state of ['active', 'retired', 'unknown']) {
      await page.goto('about:blank');
      await page.goto(`https://control.example/#generation=g1&room=${secret}`);
      await expect(page.locator('#generation-status')).toContainText(state === 'active' ? 'поддерживается' : state === 'retired' ? 'Поддержка этой комнаты завершена' : 'Не удалось проверить');
      if (state === 'retired') await expect(page.locator('#installation')).toBeHidden();
      else await expect(page.locator('#installation')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Политика конфиденциальности' })).toBeVisible();
    }
    expect(requests.every(url => !url.includes(secret) && !url.includes('#') && !url.includes('token') && !url.includes('uid'))).toBe(true);
    requests.length = 0; await page.goto('https://control.example/privacy.html');
    expect(requests.some(url => url.includes('backend-generations'))).toBe(false);
  } finally { await browser.close(); }
});

test('браузер: ожидание публикации, доступный Store и отсутствие секрета в ссылках', async () => {
  const output = mkdtempSync(join(tmpdir(), 'hosting-browser-'));
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    for (const published of ['0', '1']) {
      await page.goto('about:blank');
      const directory = prepareHosting(output, { RELEASE_STORE_PUBLISHED: published, RELEASE_STORE_ID: 'a'.repeat(32) });
      const html = readFileSync(join(directory, 'index.html'), 'utf8');
      await page.route('https://invitation.example/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://invitation.example/#room=synthetic-secret-not-for-links');
      await expect(page.locator('#installation')).toBeVisible();
      if (published === '0') {
        await expect(page.locator('#installation')).toContainText('готовится к публикации');
        await expect(page.getByRole('link', { name: 'Установить из Chrome Web Store' })).toHaveCount(0);
      } else {
        await expect(page.getByRole('link', { name: 'Установить из Chrome Web Store' })).toHaveAttribute('href', `https://chromewebstore.google.com/detail/${'a'.repeat(32)}`);
      }
      const links = await page.locator('a').evaluateAll(nodes => nodes.map(node => node.href));
      expect(links.some(link => link.includes('synthetic-secret'))).toBe(false);
      await page.locator('#installation').evaluate(element => { element.hidden = true; });
      await expect(page.getByRole('link', { name: 'Политика конфиденциальности' })).toBeVisible();
    }
  } finally { await browser.close(); rmSync(output, { recursive: true, force: true }); }
});
