import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { auditDirectory, createPackage } from '../../scripts/release/audit.mjs';
import { assertBuildEnvFiles, releaseSettings } from '../../scripts/release/config.mjs';

const values = {
  RELEASE_FIREBASE_PROJECT_ID: 'watch-together-production',
  WXT_FIREBASE_API_KEY: 'public-web-api-key', WXT_FIREBASE_PROJECT_ID: 'watch-together-production',
  WXT_FIREBASE_DATABASE_URL: 'https://watch-together-production-default-rtdb.europe-west1.firebasedatabase.app',
  WXT_FIREBASE_INVITATION_BASE_URL: 'https://watch-together-control.web.app/',
  WXT_CONTROL_PROJECT_ID: 'watch-together-control', WXT_BACKEND_GENERATION: 'g-fixture',
};
const config = releaseSettings(values);
const temporary = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-test-')); temporary.push(root);
  const directory = join(root, 'extension'); mkdirSync(directory);
  const youtube = ['https://www.youtube.com/*', 'https://youtube.com/*'];
  const invite = `${new URL(config.invitationBaseUrl).origin}/*`;
  const manifest = {
    manifest_version: 3, version: '0.1.0', name: 'Watch YouTube with friends',
    description: '__MSG_extensionDescription__', default_locale: 'en',
    permissions: ['activeTab', 'clipboardWrite', 'storage'], host_permissions: [...youtube, invite],
    icons: Object.fromEntries([16, 32, 48, 128].map(size => [size, `icon/${size}.png`])),
    background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' },
    content_scripts: ['watch-session', 'youtube-rate', 'invitation-bridge'].map((name, index) =>
      ({ matches: index === 2 ? [invite] : youtube, js: [`content-scripts/${name}.js`] })),
    content_security_policy: { extension_pages: `default-src 'self'; script-src 'self'; connect-src https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${config.databaseURL} ${new URL(config.invitationBaseUrl).origin} wss://*.firebasedatabase.app; object-src 'none'; frame-ancestors https://www.youtube.com https://youtube.com ${new URL(config.invitationBaseUrl).origin}` },
    web_accessible_resources: [{ resources: ['session.html'], matches: youtube }, { resources: ['invitation.html'], matches: [invite] }],
  };
  mkdirSync(join(directory, 'content-scripts')); mkdirSync(join(directory, 'icon'));
  for (const locale of ['en', 'ru']) {
    mkdirSync(join(directory, '_locales', locale), { recursive: true });
    copyFileSync(`public/_locales/${locale}/messages.json`, join(directory, '_locales', locale, 'messages.json'));
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'background.js'), `const config = ${JSON.stringify(config)};`);
  for (const file of ['popup.html', 'session.html', 'invitation.html']) writeFileSync(join(directory, file), '<!doctype html><title>Extension</title>');
  for (const script of manifest.content_scripts) writeFileSync(join(directory, script.js[0]), '/* bundled code */');
  for (const size of [16, 32, 48, 128]) copyFileSync(`public/icon/${size}.png`, join(directory, `icon/${size}.png`));
  return { root, directory, manifest, destination: join(root, 'release.zip') };
}

describe('проверка поставляемого ZIP', () => {
  it('включает оба словаря и отклоняет пропущенные переводы и неверный fallback', () => {
    const f = fixture();
    createPackage(f.directory, f.destination, config, '0.1.0');
    expect(execFileSync('unzip', ['-Z1', f.destination], { encoding: 'utf8' })).toContain('_locales/ru/messages.json');
    f.manifest.default_locale = 'ru';
    writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('локализация manifest');
    f.manifest.default_locale = 'en';
    writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest));
    const path = join(f.directory, '_locales/ru/messages.json');
    const messages = JSON.parse(readFileSync(path, 'utf8'));
    messages.participant.message = 'Участник';
    writeFileSync(path, JSON.stringify(messages));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('несогласованные словари');
    rmSync(path);
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('словарь локализации');
  });
  it('включает подготовленный баннер popup, но отклоняет другие изображения', () => {
    const f = fixture();
    mkdirSync(join(f.directory, 'assets'));
    copyFileSync('public/assets/popup-plush.webp', join(f.directory, 'assets/popup-plush.webp'));
    createPackage(f.directory, f.destination, config, '0.1.0');
    expect(execFileSync('unzip', ['-Z1', f.destination], { encoding: 'utf8' }).split('\n')).toContain('assets/popup-plush.webp');
    copyFileSync('public/assets/popup-plush.webp', join(f.directory, 'assets/unapproved.webp'));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('запрещённый путь');
  });
  it('проверяет распакованный ZIP, manifest в корне и SHA самого архива', () => {
    const f = fixture();
    const result = createPackage(f.directory, f.destination, config, '0.1.0');
    expect(execFileSync('unzip', ['-Z1', f.destination], { encoding: 'utf8' }).split('\n')).toContain('manifest.json');
    expect(result.sha256).toBe(createHash('sha256').update(readFileSync(f.destination)).digest('hex'));
    expect(readFileSync(`${f.destination}.sha256`, 'utf8')).toContain(result.sha256);
    expect(readFileSync(`${f.destination}.audit.json`, 'utf8')).not.toContain(config.apiKey);
  });
  it.each([
    ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['jwt', `eyJ${'a'.repeat(16)}.${'b'.repeat(20)}.${'c'.repeat(20)}`],
    ['service-account', JSON.stringify({ type: 'service_' + 'account' })],
    ['google-refresh-token', `1//${'X'.repeat(45)}`],
    ['known-private-value', 'synthetic_private_room_invitation_1234567890'],
    ['known-private-value', 'synthetic_private_env_secret_1234567890'],
    ['qa-instrumentation', 'native-media.js'],
    ['remote-code', '<script src="https://bad.example/code.js"></script>'],
  ])('отказывает при %s, скрывает секрет и убирает старый ready ZIP', (kind, secret) => {
    const f = fixture();
    createPackage(f.directory, f.destination, config, '0.1.0');
    writeFileSync(join(f.directory, 'content-scripts/watch-session.js'), secret);
    let message = '';
    try { createPackage(f.directory, f.destination, config, '0.1.0', {
      env: { WXT_PRIVATE_KEY: 'synthetic_private_env_secret_1234567890' },
      knownSecrets: ['synthetic_private_room_invitation_1234567890'],
    }); } catch (error) { message = String(error); }
    expect(message).toContain(kind); expect(message).not.toContain(secret);
    expect(existsSync(f.destination)).toBe(false);
    expect(existsSync(`${f.destination}.sha256`)).toBe(false);
    expect(existsSync(`${f.destination}.audit.json`)).toBe(false);
  });
  it.each(['.env', 'background.js.map', 'native-media.js'])('отклоняет лишние файлы: %s', name => {
    const f = fixture(); writeFileSync(join(f.directory, name), 'not for shipping');
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('запрещённый путь');
  });
  it('не захватывает файлы за пределами каталога расширения', () => {
    const f = fixture(); writeFileSync(join(f.root, 'secret'), 'outside package');
    createPackage(f.directory, f.destination, config, '0.1.0');
    expect(execFileSync('unzip', ['-Z1', f.destination], { encoding: 'utf8' })).not.toContain('secret');
  });
  it('отклоняет symlink и расширение полномочий manifest', () => {
    const f = fixture(); symlinkSync('/tmp', join(f.directory, 'linked'));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('symlink');
    rmSync(join(f.directory, 'linked')); f.manifest.permissions.push('tabs');
    writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('manifest/permissions');
  });
  it('проверяет отсутствующие файлы manifest и размеры иконок', () => {
    const f = fixture(); rmSync(join(f.directory, 'popup.html'));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('ресурс manifest');
    writeFileSync(join(f.directory, 'popup.html'), '<title>Popup</title>');
    copyFileSync('public/icon/16.png', join(f.directory, 'icon/128.png'));
    expect(() => auditDirectory(f.directory, config, '0.1.0')).toThrow('PNG-размер');
  });
  it('отклоняет auto-env, который WXT загрузил бы после запуска launcher', () => {
    const f = fixture(); writeFileSync(join(f.root, '.env.local'), 'WXT_PRIVATE_SECRET=never-ship-this-value');
    expect(() => assertBuildEnvFiles(values, f.root)).toThrow('конфликт');
    writeFileSync(join(f.root, '.env.local'), 'WXT_FIREBASE_API_KEY=another-key');
    expect(() => assertBuildEnvFiles(values, f.root)).toThrow('конфликт');
  });
});
