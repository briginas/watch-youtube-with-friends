import { defineConfig } from 'wxt';
import { firebaseSettings } from './src/lib/firebase/settings';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const firebaseProbe = process.env.WXT_FIREBASE_PROBE === '1';
const playerProbe = process.env.WXT_PLAYER_PROBE === '1';
const localTransport = process.env.WXT_FIREBASE_EMULATORS === '1';
const release = process.env.WXT_RELEASE === '1';
const mainBuild = !firebaseProbe && !playerProbe;
const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const youtube = ['https://www.youtube.com/*', 'https://youtube.com/*'];
const firebase = mainBuild ? firebaseSettings(process.env) : null;
const cloud = firebase && !firebase.emulators ? firebase : null;
if (release && (!cloud || firebaseProbe || playerProbe || localTransport ||
    cloud.projectId !== process.env.RELEASE_FIREBASE_PROJECT_ID || /(?:^|-)(?:qa|test|demo)(?:-|$)/.test(cloud.projectId))) {
  throw new Error('Release: требуется отдельное production-окружение.');
}
const invitationOrigin = firebase ? new URL(firebase.invitationBaseUrl).origin : null;
const invitationMatch = localTransport ? 'http://127.0.0.1/*' : invitationOrigin ? `${invitationOrigin}/*` : null;
const connectSources = localTransport
  ? 'http://127.0.0.1:9099 http://127.0.0.1:9000 ws://127.0.0.1:9000 http://127.0.0.1:5002'
  : cloud ? `https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${cloud.databaseURL} ${invitationOrigin} wss://*.${new URL(cloud.databaseURL).hostname.endsWith('.firebaseio.com') ? 'firebaseio.com' : 'firebasedatabase.app'}` : "'self'";

function sourceRevision(): string {
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    const commit = git('rev-parse', '--short=8', 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=normal');
    return dirty ? `${commit} dirty` : commit;
  } catch {
    return 'no-git';
  }
}

export default defineConfig({
  srcDir: firebaseProbe ? 'experiments/firebase-context' : playerProbe ? 'experiments/youtube-player' : 'src',
  outDir: release ? '.output/release' : firebaseProbe ? '.output/firebase-context' : playerProbe ? '.output/youtube-player' : localTransport ? '.output/room-transport' : cloud ? '.output/cloud' : '.output',
  // WXT читает .env.production после загрузки user config. Фиксируем runtime env
  // по уже выбранному режиму, чтобы обычная/QA сборка не подключилась к production.
  vite: () => ({
    build: { sourcemap: false },
    define: { __RELEASE_VERSION__: JSON.stringify(version), ...Object.fromEntries(Object.entries({
      WXT_RELEASE: release ? '1' : '0',
      WXT_FIREBASE_EMULATORS: localTransport ? '1' : '0',
      WXT_FIREBASE_API_KEY: cloud?.apiKey,
      WXT_FIREBASE_PROJECT_ID: cloud?.projectId,
      WXT_FIREBASE_DATABASE_URL: cloud?.databaseURL,
      WXT_FIREBASE_INVITATION_BASE_URL: cloud?.invitationBaseUrl,
      WXT_BACKEND_GENERATION: firebase?.backendGeneration,
      WXT_CONTROL_PROJECT_ID: firebase?.controlProjectId,
    }).map(([key, value]) => [`import.meta.env.${key}`, value === undefined ? 'undefined' : JSON.stringify(value)])) },
  }),
  publicDir: 'public',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      if (mainBuild && !release && wxt.config.browser === 'chrome') {
        manifest.version_name = `${version} dev · ${sourceRevision()} · ${new Date().toISOString()}`;
      }
    },
  },
  ...(mainBuild && !firebase ? { filterEntrypoints: ['background', 'popup', 'session', 'watch-session', 'youtube-rate'] } : {}),
  manifest: {
    name: 'Watch YouTube with friends',
    description: 'Совместный просмотр видео на YouTube.',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    permissions: ['activeTab', ...(mainBuild ? ['clipboardWrite', 'storage'] : [])],
    ...(mainBuild ? {
      host_permissions: [...youtube, ...(invitationMatch ? [invitationMatch] : [])],
      web_accessible_resources: [
        { resources: ['session.html'], matches: youtube },
        ...(invitationMatch ? [{ resources: ['invitation.html'], matches: [invitationMatch] }] : []),
      ],
      content_security_policy: {
        extension_pages: `default-src 'self'; script-src 'self'; connect-src ${connectSources}; object-src 'none'; frame-ancestors https://www.youtube.com https://youtube.com${invitationOrigin ? ` ${invitationOrigin}` : ''}`,
      },
    } : {}),
    ...(playerProbe ? {
      name: 'Watch together — YouTube player experiment',
      host_permissions: ['https://www.youtube.com/*'],
    } : {}),
    ...(firebaseProbe ? {
      name: 'Watch together — local Firebase experiment',
      host_permissions: ['http://127.0.0.1/*'],
      web_accessible_resources: [{
        resources: ['session.html'],
        matches: ['http://127.0.0.1/*'],
      }],
      content_security_policy: {
        extension_pages: "default-src 'self'; script-src 'self'; connect-src http://127.0.0.1:9099 http://127.0.0.1:9000 ws://127.0.0.1:9000; object-src 'none'; frame-ancestors http://127.0.0.1:5002",
      },
    } : {}),
  },
});
