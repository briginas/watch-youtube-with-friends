import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertBuildEnvFiles, buildEnvironment, readProduction } from './release/config.mjs';
import { auditDirectory, createPackage } from './release/audit.mjs';
import { deployRelease, json, loadRelease, prepareBackend, prepareRelease, readJson } from './release/generation.mjs';
import { controlHostingConfig, prepareControlHosting } from './release/hosting.mjs';
import { parseRegistry } from '../src/lib/backend-generations.ts';

const command = process.argv[2];
const output = resolve('.output/release');
const directory = `${output}/chrome-mv3`;
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const destination = `${output}/watch-together-${version}.zip`;
const run = (file, args, env) => execFileSync(process.execPath, [resolve(file), ...args], { stdio: 'pipe', env });
try {
  if (!['build', 'audit', 'prepare', 'prepare-backend', 'deploy-backend', 'prepare-control', 'deploy-control'].includes(command))
    throw new Error('Release: команда build|audit|prepare|prepare-backend|deploy-backend|prepare-control|deploy-control.');
  if (command === 'build') {
    // До чтения настроек убираем старые результаты: ошибка конфигурации не оставляет готовый ZIP.
    rmSync(output, { recursive: true, force: true });
  }
  const { config, values } = readProduction();
  if (command === 'prepare') {
    const [mode, releaseVersion, backendGeneration] = process.argv.slice(3);
    prepareRelease(config, version, mode, { releaseVersion, backendGeneration });
    console.log(`Release ${version}: descriptor и контракт подготовлены.`);
  } else if (command === 'build' || command === 'audit') {
    const { descriptor } = loadRelease(config, version);
    assertBuildEnvFiles(values);
    mkdirSync(output, { recursive: true });
    if (command === 'build') {
      run('node_modules/wxt/bin/wxt.mjs', ['build', '-b', 'chrome', '--mv3', '--mode', 'production'], buildEnvironment(values));
    }
    const knownSecrets = [];
    const collect = directory => {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}/${file.name}`;
        if (file.isDirectory()) collect(path);
        else if (/\.[cm]?[jt]s$/.test(file.name)) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(/["']([a-f0-9]{64})["']/g)) knownSecrets.push(match[1]);
          for (const match of source.matchAll(/(?:secret|token|roomKey|invitationKey)\s*[:=]\s*["']([^"'\n]{12,})["']/gi)) knownSecrets.push(match[1]);
        }
      }
    };
    collect('tests');
    const auditEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|_KEY$/.test(key))), ...values };
    const options = { env: auditEnv, knownSecrets };
    auditDirectory(directory, config, version, options);
    const result = createPackage(directory, destination, config, version, options);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    json(`${output}/build-info.json`, { version, commit, descriptor, sourceMayHaveUncommittedChanges: true, ...result });
    console.log(`Release ${version}: ${result.files} файлов; ZIP ${result.zip}; SHA-256 ${result.sha256}`);
  } else {
    const role = command.endsWith('backend') ? 'backend' : 'control';
    const deploy = command.startsWith('deploy-');
    const release = loadRelease(config, version);
    const deployOutput = resolve('.output', `release-${role}`);
    mkdirSync(deployOutput, { recursive: true });
    const path = `${deployOutput}/firebase.json`;
    rmSync(path, { force: true });
    if (role === 'backend') {
      if (deploy && release.entry.provenance !== 'live')
        throw new Error('Release: перед deploy подтвердите backend через фактический инвентарь.');
      json(path, prepareBackend(deployOutput, release));
    }
    else {
      let previous;
      if (deploy) {
        const response = await fetch(new URL('backend-generations.json', config.invitationBaseUrl), {
          redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          previous = parseRegistry(await response.json());
          if (!previous) throw new Error('Release: опубликованный реестр не прошёл проверку.');
        } else if (response.status !== 404 || process.argv[3] !== '--initial-control') {
          throw new Error('Release: не удалось проверить опубликованный реестр.');
        }
      } else if (process.argv[3]) {
        previous = parseRegistry(readJson(process.argv[3]));
        if (!previous) throw new Error('Release: предыдущий реестр не прошёл проверку.');
      }
      const directory = prepareControlHosting(deployOutput, values, undefined, previous);
      json(path, controlHostingConfig(config, directory));
    }
    if (deploy) deployRelease(role, config, path, args => run('node_modules/firebase-tools/lib/bin/firebase.js', args, process.env));
    console.log(`Release ${role}: ${deploy ? 'deploy выполнен' : 'файлы подготовлены'}.`);
  }
} catch (error) {
  if (command === 'build' || command === 'audit') {
    for (const path of [destination, `${destination}.sha256`, `${destination}.audit.json`, `${output}/build-info.json`]) rmSync(path, { force: true });
  }
  // Дочерний процесс может вывести credentials в исключение, поэтому его вывод не печатаем.
  const message = error instanceof Error && /^(?:Release|Audit):/.test(error.message) ? error.message : 'Release: ошибка дочерней команды; значения конфигурации и вывод процесса скрыты.';
  console.error(message);
  process.exitCode = 1;
}
