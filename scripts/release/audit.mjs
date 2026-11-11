import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { publicKeys } from './config.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const allowedPath = /^(?:manifest\.json|_locales\/(?:en|ru)\/messages\.json|(?:popup|session|invitation)\.html|background\.js|(?:chunks|content-scripts)\/[\w.-]+\.js|assets\/[\w.-]+\.css|assets\/popup-plush\.webp|icon\/(?:16|32|48|128)\.png)$/;
const patterns = {
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  'service-account': /["']type["']\s*:\s*["']service_account["']/,
  'jwt': /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  'github-token': /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  'aws-access-key': /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  'slack-token': /xox[baprs]-[A-Za-z0-9-]{20,}/,
  'google-refresh-token': /1\/\/[A-Za-z0-9_-]{40,}/,
  'secret-api-key': /sk_(?:live|test)_[A-Za-z0-9]{20,}/,
  'qa-instrumentation': /native-media\.js|native-status\.js|__WATCH_TOGETHER_QA|Sync QA —/,
  'qa-project': /\b[a-z0-9-]*-qa(?:-[a-z0-9]+)*\b|demo-watch-together/,
  'private-home-path': /\/Users\/[A-Za-z0-9_.-]+\//,
  'remote-code': /<script\b[^>]*\bsrc=["']https?:|\bimport\s*\(\s*["']https?:|\bimportScripts\s*\(\s*["']https?:/i,
};

export function listFiles(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const relative = prefix + name;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Audit: symlink/специальный файл запрещён.');
    if (stat.isDirectory()) return listFiles(path, `${relative}/`);
    if (!allowedPath.test(relative)) throw new Error('Audit: запрещённый путь или тип файла.');
    return [relative];
  });
}

export function auditDirectory(directory, config, version, { env = {}, knownSecrets = [] } = {}) {
  const files = listFiles(directory);
  if (!files.includes('manifest.json')) throw new Error('Audit: manifest отсутствует в корне.');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const youtube = ['https://www.youtube.com/*', 'https://youtube.com/*'];
  const invite = `${new URL(config.invitationBaseUrl).origin}/*`;
  if (manifest.manifest_version !== 3 || manifest.version !== version ||
    manifest.name !== 'Watch YouTube with friends' || !manifest.description || manifest.description.length > 132 ||
    !same(manifest.permissions ?? [], ['activeTab', 'clipboardWrite', 'storage']) ||
    !same(manifest.host_permissions ?? [], [...youtube, invite]) || manifest.optional_permissions?.length ||
    manifest.optional_host_permissions?.length || manifest.externally_connectable || manifest.devtools_page ||
    manifest.update_url || manifest.key) throw new Error('Audit: недопустимый manifest/permissions.');
  if (manifest.default_locale !== 'en' || manifest.description !== '__MSG_extensionDescription__') {
    throw new Error('Audit: неверная локализация manifest.');
  }
  let catalogs;
  try {
    catalogs = ['en', 'ru'].map(locale => JSON.parse(readFileSync(join(directory, '_locales', locale, 'messages.json'), 'utf8')));
  } catch { throw new Error('Audit: отсутствует или повреждён словарь локализации.'); }
  const [english, russian] = catalogs;
  const keys = Object.keys(english ?? {});
  if (!keys.length || !same(keys, Object.keys(russian ?? {})) || keys.some(key =>
    catalogs.some(catalog => typeof catalog[key]?.message !== 'string' || !catalog[key].message.trim()) ||
    !same(english[key].message.match(/\$(?:\d|[a-z][\w]*\$)/gi) ?? [], russian[key].message.match(/\$(?:\d|[a-z][\w]*\$)/gi) ?? []) ||
    JSON.stringify(english[key].placeholders ?? {}) !== JSON.stringify(russian[key].placeholders ?? {}) ||
    catalogs.some(catalog => [...catalog[key].message.matchAll(/\$([\w]+)\$/g)]
      .some(([, name]) => !catalog[key].placeholders?.[name.toLowerCase()]?.content))) ||
    catalogs.some(catalog => !catalog.extensionDescription?.message || catalog.extensionDescription.message.length > 132)) {
    throw new Error('Audit: неполные или несогласованные словари локализации.');
  }
  const hostname = new URL(config.databaseURL).hostname;
  const connect = `https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${config.databaseURL} ${new URL(config.invitationBaseUrl).origin} wss://*.${hostname.endsWith('.firebaseio.com') ? 'firebaseio.com' : 'firebasedatabase.app'}`;
  const csp = `default-src 'self'; script-src 'self'; connect-src ${connect}; object-src 'none'; frame-ancestors https://www.youtube.com https://youtube.com ${new URL(config.invitationBaseUrl).origin}`;
  if (manifest.content_security_policy?.extension_pages !== csp) throw new Error('Audit: CSP не соответствует production.');
  const expectedResources = [
    { resources: ['session.html'], matches: youtube },
    { resources: ['invitation.html'], matches: [invite] },
  ];
  if (JSON.stringify(manifest.web_accessible_resources) !== JSON.stringify(expectedResources)) throw new Error('Audit: web-accessible resources не соответствуют контракту.');
  const resources = [manifest.background?.service_worker, manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    ...(manifest.web_accessible_resources ?? []).flatMap(entry => entry.resources)];
  if (resources.some(path => typeof path !== 'string' || !files.includes(path))) throw new Error('Audit: отсутствует ресурс manifest.');
  const scripts = manifest.content_scripts ?? [];
  if (scripts.length !== 3 || scripts.some(script => !script.matches?.length || script.matches.some(match => ![...youtube, invite].includes(match)))) {
    throw new Error('Audit: недопустимые content script matches.');
  }
  for (const size of [16, 32, 48, 128]) {
    const path = manifest.icons?.[size];
    if (path !== `icon/${size}.png`) throw new Error('Audit: иконки manifest отсутствуют.');
    const bytes = readFileSync(join(directory, path));
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.length < 24 ||
      bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) throw new Error('Audit: неверный PNG-размер.');
  }
  const secrets = [...knownSecrets, ...Object.entries(env).filter(([key, value]) =>
    !publicKeys.includes(key) && key !== 'RELEASE_FIREBASE_PROJECT_ID' && typeof value === 'string' && value.length >= 12).map(([, value]) => value)];
  const findings = [];
  const texts = [];
  const inventory = files.map(file => {
    const bytes = readFileSync(join(directory, file));
    const text = file + '\n' + bytes.toString('utf8');
    if (!file.endsWith('.png')) texts.push(text);
    for (const [kind, pattern] of Object.entries(patterns)) if (pattern.test(text)) findings.push({ file, kind });
    if (secrets.some(secret => secret && text.includes(secret))) findings.push({ file, kind: 'known-private-value' });
    return { file, bytes: bytes.length, sha256: sha(bytes) };
  });
  if ([config.apiKey, config.projectId, config.databaseURL, config.invitationBaseUrl, config.backendGeneration, config.controlProjectId]
    .some(value => !texts.some(text => text.includes(value)))) throw new Error('Audit: runtime-конфигурация production отсутствует.');
  if (findings.length) {
    // Ни совпавший текст, ни потенциально чувствительные имена файлов в ошибку не попадают.
    const error = new Error(`Audit: обнаружены запрещённые данные (${findings.length}); категории: ${[...new Set(findings.map(item => item.kind))].join(', ')}.`);
    throw error;
  }
  return { version, backendGeneration: config.backendGeneration, projectId: config.projectId, databaseURL: config.databaseURL,
    controlProjectId: config.controlProjectId,
    invitationBaseUrl: config.invitationBaseUrl, publicFirebaseApiKey: 'included; public config; value omitted',
    permissions: manifest.permissions, hostPermissions: manifest.host_permissions,
    inventory, findings, limitations: 'Static checks of known formats and supplied secrets; runtime Auth/storage and all possible secret formats are not covered.' };
}

export function createPackage(directory, destination, config, version, options = {}) {
  const zip = resolve(destination);
  const checksum = `${zip}.sha256`;
  const report = `${zip}.audit.json`;
  // Старый ZIP и его отчёт не должны выглядеть результатом неудачного нового запуска.
  for (const file of [zip, checksum, report]) rmSync(file, { force: true });
  mkdirSync(dirname(zip), { recursive: true });
  const temporary = mkdtempSync(join(dirname(zip), '.package-'));
  try {
    const before = auditDirectory(directory, config, version, options);
    const pending = join(temporary, 'pending.zip');
    execFileSync('zip', ['-X', '-q', pending, '-@'], { cwd: directory, input: before.inventory.map(item => item.file).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
    const paths = execFileSync('unzip', ['-Z1', pending], { encoding: 'utf8' }).trim().split('\n');
    if (!same(paths, before.inventory.map(item => item.file))) throw new Error('Audit: состав ZIP отличается от сборки.');
    const unpacked = join(temporary, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('unzip', ['-q', pending, '-d', unpacked], { stdio: 'pipe' });
    const after = auditDirectory(unpacked, config, version, options);
    if (JSON.stringify(before.inventory) !== JSON.stringify(after.inventory)) throw new Error('Audit: содержимое ZIP изменилось при упаковке.');
    const digest = sha(readFileSync(pending));
    writeFileSync(checksum, `${digest}  ${zip.split('/').at(-1)}\n`);
    writeFileSync(report, JSON.stringify({ ...after, zipSha256: digest }, null, 2) + '\n');
    renameSync(pending, zip);
    return { zip, sha256: digest, files: after.inventory.length };
  } catch (error) {
    for (const file of [zip, checksum, report]) rmSync(file, { force: true });
    // ZIP utility errors can echo file names or file contents; do not propagate their stderr.
    if (error instanceof Error && error.message.startsWith('Audit:')) throw error;
    throw new Error('Audit: не удалось создать или проверить ZIP.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
