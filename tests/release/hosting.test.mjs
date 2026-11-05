import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHosting } from '../../scripts/release/hosting.mjs';

const temporary = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function prepare(values) {
  const root = mkdtempSync(join(tmpdir(), 'release-hosting-')); temporary.push(root);
  return readFileSync(join(prepareHosting(root, values), 'index.html'), 'utf8');
}
describe('публичная страница установки', () => {
  it('показывает нейтральный контакт без настроек и подставляет выбранный email на обеих страницах', () => {
    expect(prepare({})).toContain('Контакт поддержки не настроен.');
    const root = mkdtempSync(join(tmpdir(), 'release-contact-')); temporary.push(root);
    const directory = prepareHosting(root, { RELEASE_SUPPORT_EMAIL: 'support@example.invalid' });
    for (const name of ['index.html', 'privacy.html']) {
      expect(readFileSync(join(directory, name), 'utf8')).toContain('href="mailto:support@example.invalid"');
    }
    expect(() => prepare({ RELEASE_SUPPORT_EMAIL: 'bad@example.invalid"><script>' })).toThrow('RELEASE_SUPPORT_EMAIL');
  });
  it('до публикации показывает ожидание, сохраняет privacy вне installation', () => {
    const html = prepare({ RELEASE_STORE_ID: 'a'.repeat(32) });
    expect(html).toContain('готовится к публикации');
    expect(html).not.toContain('chromewebstore.google.com');
    expect(html.indexOf('href="/privacy.html"')).toBeGreaterThan(html.indexOf('</section>'));
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
  it('после публикации добавляет каноническую ссылку без invitation fragment', () => {
    const html = prepare({ RELEASE_STORE_ID: 'a'.repeat(32), RELEASE_STORE_PUBLISHED: '1' });
    expect(html).toContain(`href="https://chromewebstore.google.com/detail/${'a'.repeat(32)}" rel="noreferrer"`);
    expect(html).not.toContain('готовится к публикации');
    expect(html).not.toContain('#room=');
  });
  it.each([
    { RELEASE_STORE_PUBLISHED: '1' },
    { RELEASE_STORE_PUBLISHED: 'maybe' },
    { RELEASE_STORE_ID: 'https://bad.example/#room=secret' },
  ])('не генерирует страницу при неверном состоянии', values => {
    expect(() => prepare(values)).toThrow('состояние Chrome Web Store');
  });
});
