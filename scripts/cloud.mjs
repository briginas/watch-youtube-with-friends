import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { qaSettings } from '../src/lib/firebase/qa-settings.ts';
import { generationRules } from './generation-rules.mjs';
import { prepareHosting } from './release/hosting.mjs';
import { prepareStatus } from './service-status.mjs';

let config;
try {
  loadEnvFile('.env.cloud');
  config = qaSettings(process.env);
} catch (error) {
  console.error(error.message?.startsWith('QA:') ? error.message : 'QA: создайте .env.cloud по .env.example (npm run config:init).');
  process.exit(1);
}
const command = process.argv[2];
if (!['build', 'deploy', 'deploy-rules', 'measure'].includes(command)) throw new Error('Использование: cloud.mjs build|deploy|deploy-rules|measure');
const output = resolve('.output/cloud');
mkdirSync(output, { recursive: true });
// Облачные Rules используют тот же контракт rooms, без экспериментальных _probes.
const rules = generationRules(config.backendGeneration);
writeFileSync(`${output}/database.rules.json`, JSON.stringify(rules, null, 2));
const local = JSON.parse(readFileSync('firebase.json', 'utf8'));
const hosting = prepareHosting(output, {});
rmSync(`${hosting}/generations`, { recursive: true, force: true });
rmSync(`${hosting}/service-status.json`, { force: true });
const firstRelease = JSON.parse(readFileSync('package.json', 'utf8')).version;
const updatedAt = new Date().toISOString();
writeFileSync(`${hosting}/backend-generations.json`, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt,
  generations: [{ generation: config.backendGeneration, firstRelease, state: 'active' }],
}));
const statusDirectory = `${hosting}/generations/${config.backendGeneration}`;
mkdirSync(statusDirectory, { recursive: true });
writeFileSync(`${statusDirectory}/service-status.json`, JSON.stringify(prepareStatus('operational', { seconds: 86400 })));
writeFileSync(`${output}/firebase.json`, JSON.stringify({
  database: { instance: new URL(config.databaseURL).hostname.split('.')[0], rules: `${output}/database.rules.json` },
  auth: { providers: { anonymous: true } },
  hosting: { ...local.hosting, site: new URL(config.invitationBaseUrl).hostname.endsWith('.web.app')
    ? new URL(config.invitationBaseUrl).hostname.split('.')[0] : config.projectId,
  public: hosting },
}, null, 2));

const run = (cli, args) => {
  const result = spawnSync(process.execPath, [resolve(cli), ...args], { stdio: 'inherit', env: { ...process.env, WXT_RELEASE: '0' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (command === 'deploy' || command === 'deploy-rules') {
  run('node_modules/firebase-tools/lib/bin/firebase.js', ['deploy', '--project', config.projectId,
    '--config', `${output}/firebase.json`, '--only', command === 'deploy-rules' ? 'database' : 'database,hosting,auth', '--non-interactive']);
} else {
  run('node_modules/wxt/bin/wxt.mjs', ['build', '-b', 'chrome', '--mv3']);
  if (command === 'measure') run('node_modules/@playwright/test/cli.js', ['test', '--config', 'playwright.cloud.config.ts']);
}
