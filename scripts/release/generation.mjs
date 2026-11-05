import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareVersions, inventorySchema, releaseDescriptorSchema } from '../../src/lib/backend-generations.ts';
import { generationRules } from '../generation-rules.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = (file, value, options) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', options);
export const readJson = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Release: отсутствует файл конфигурации. Выполните npm run config:init и заполните .local/deployment по docs/configuration.md.');
    throw error;
  }
};
const occupied = new Set(['provisioned', 'active', 'retiring']);
const descriptorPath = (root, version) => join(root, 'releases', version + '.json');

function snapshot(root, generation) {
  root = realpathSync(root);
  const folder = join('contracts', generation);
  const rulesPath = join(folder, 'database.rules.json');
  const schemaPath = join(folder, 'schema.json');
  const read = path => {
    const file = resolve(root, path);
    if (realpathSync(file) !== file) throw new Error('Release: путь снимка содержит symlink.');
    return readFileSync(file);
  };
  const rules = read(rulesPath);
  const schema = read(schemaPath);
  if (JSON.parse(schema).backendGeneration !== generation) throw new Error('Release: поколение снимка не совпадает.');
  return { rules, contract: { rulesPath, rulesSha256: digest(rules), schemaPath, schemaSha256: digest(schema) } };
}

function validateMapping(descriptor, inventory) {
  const entry = inventory.projects.find(item => item.role === 'backend' && item.generation === descriptor.backendGeneration);
  const control = inventory.projects.find(item => item.role === 'control' && item.projectId === descriptor.control.projectId);
  const allowed = descriptor.mode === 'new' ? ['planned', 'provisioned', 'active'] : ['active'];
  if (descriptor.backendGeneration === 'legacy' || !entry || entry.projectId !== descriptor.backend.projectId || entry.firstRelease !== descriptor.firstRelease ||
      !control || !allowed.includes(entry.state)) throw new Error('Release: descriptor не совпадает с инвентарём или поколение выведено.');
  return entry;
}

function previous(root, inventory, descriptor) {
  const ref = descriptor.previous;
  const entry = inventory.projects.find(item => item.role === 'backend' && item.generation === ref.backendGeneration);
  if (!entry || compareVersions(ref.releaseVersion, entry.firstRelease) < 0)
    throw new Error('Release: предшествующий релиз отсутствует в истории.');
  // Legacy 0.2.0 уже подготовлен до появления descriptors.
  if (ref.backendGeneration === 'legacy' && ref.releaseVersion === '0.2.0' && descriptor.mode === 'new') return;
  const prior = releaseDescriptorSchema.parse(readJson(descriptorPath(root, ref.releaseVersion)));
  if (prior.releaseVersion !== ref.releaseVersion || prior.backendGeneration !== ref.backendGeneration ||
      prior.backend.projectId !== entry.projectId || prior.firstRelease !== entry.firstRelease ||
      prior.control.projectId !== descriptor.control.projectId)
    throw new Error('Release: предшествующий descriptor противоречит выбранному релизу.');
  return prior;
}

export function loadRelease(config, version, root = '.local/deployment/generations') {
  const descriptor = releaseDescriptorSchema.parse(readJson(descriptorPath(root, version)));
  const inventory = inventorySchema.parse(readJson(join(root, 'inventory.json')));
  const entry = validateMapping(descriptor, inventory);
  const prior = previous(root, inventory, descriptor);
  if (descriptor.releaseVersion !== version || descriptor.backendGeneration !== config.backendGeneration ||
      descriptor.backend.projectId !== config.projectId || new URL(descriptor.backend.databaseOrigin).origin !== config.databaseURL ||
      descriptor.control.projectId !== config.controlProjectId || new URL(descriptor.control.origin).href !== config.invitationBaseUrl)
    throw new Error('Release: настройки сборки противоречат descriptor.');
  const saved = snapshot(root, descriptor.backendGeneration);
  if (Object.entries(saved.contract).some(([key, value]) => descriptor.contract[key] !== value ||
      (descriptor.mode === 'reuse' && prior.contract[key] !== value)))
    throw new Error('Release: путь или хэш снимка контракта изменился.');
  return { descriptor, entry, rules: saved.rules };
}

export function prepareRelease(config, version, mode, prior, root = '.local/deployment/generations') {
  const inventory = inventorySchema.parse(readJson(join(root, 'inventory.json')));
  const generation = config.backendGeneration;
  const entry = inventory.projects.find(item => item.role === 'backend' && item.generation === generation);
  if (!entry || generation === 'legacy') throw new Error('Release: требуется поколение нового формата из инвентаря.');
  const { contract } = mode === 'reuse' ? snapshot(root, generation) : { contract: {
    rulesPath: join('contracts', generation, 'database.rules.json'), rulesSha256: '0'.repeat(64),
    schemaPath: join('contracts', generation, 'schema.json'), schemaSha256: '0'.repeat(64),
  } };
  const descriptor = releaseDescriptorSchema.parse({
    schemaVersion: 1, releaseVersion: version, mode, backendGeneration: generation, firstRelease: entry.firstRelease,
    previous: prior, backend: { projectId: config.projectId, databaseOrigin: config.databaseURL },
    control: { projectId: config.controlProjectId, origin: config.invitationBaseUrl }, contract,
  });
  validateMapping(descriptor, inventory);
  const predecessor = previous(root, inventory, descriptor);
  if (mode === 'reuse' && Object.entries(contract).some(([key, value]) => predecessor.contract[key] !== value))
    throw new Error('Release: reuse требует неизменный контракт предшествующего релиза.');
  if (mode === 'new') {
    const contracts = join(root, 'contracts');
    mkdirSync(contracts, { recursive: true });
    const pending = mkdtempSync(join(contracts, '.snapshot-'));
    try {
      json(join(pending, 'database.rules.json'), generationRules(generation));
      json(join(pending, 'schema.json'), { schemaVersion: 1, backendGeneration: generation,
        metadata: ['name', 'createdWithVersion', 'backendGeneration'] });
      const rulesHash = digest(readFileSync(join(pending, 'database.rules.json')));
      const schemaHash = digest(readFileSync(join(pending, 'schema.json')));
      const destination = join(contracts, generation);
      try { renameSync(pending, destination); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      descriptor.contract = snapshot(root, generation).contract;
      if (descriptor.contract.rulesSha256 !== rulesHash || descriptor.contract.schemaSha256 !== schemaHash)
        throw new Error('Release: уже сохранённый контракт поколения отличается.');
    } finally { rmSync(pending, { recursive: true, force: true }); }
  }
  mkdirSync(join(root, 'releases'), { recursive: true });
  json(descriptorPath(root, version), descriptor, { flag: 'wx' });
  return descriptor;
}

export function prepareBackend(output, release) {
  const { descriptor, rules } = release;
  if (descriptor.mode !== 'new' || !occupied.has(release.entry.state) || release.entry.state === 'retiring')
    throw new Error('Release: deploy backend доступен для provisioned/active нового поколения.');
  mkdirSync(output, { recursive: true });
  const rulesPath = resolve(output, 'database.rules.json');
  writeFileSync(rulesPath, rules);
  return {
    database: { instance: new URL(descriptor.backend.databaseOrigin).hostname.split('.')[0], rules: rulesPath },
    auth: { providers: { anonymous: true } },
  };
}

export function deployRelease(role, config, path, run) {
  const project = role === 'backend' ? config.projectId : config.controlProjectId;
  const resources = role === 'backend' ? 'database,auth' : 'hosting';
  if (!['backend', 'control'].includes(role) || !project || config.projectId === config.controlProjectId)
    throw new Error('Release: некорректная роль deploy.');
  return run(['deploy', '--project', project, '--config', path, '--only', resources, '--non-interactive']);
}
