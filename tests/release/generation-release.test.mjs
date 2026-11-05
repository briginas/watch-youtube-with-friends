import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deployRelease, json, loadRelease, prepareBackend, prepareRelease, readJson } from '../../scripts/release/generation.mjs';

it('готовит неизменяемый new, reuse использует тот же снимок, deploy строго разделён', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-generation-'));
  try {
    const config = { backendGeneration: 'g1', projectId: 'fixture-backend', controlProjectId: 'fixture-control',
      databaseURL: 'https://fixture-backend-default-rtdb.europe-west1.firebasedatabase.app',
      invitationBaseUrl: 'https://fixture-control.web.app/' };
    const inventory = readJson('tests/fixtures/generations/release-inventory.json');
    inventory.projects.push({ role: 'control', projectId: config.controlProjectId },
      { role: 'backend', projectId: config.projectId, generation: 'g1', firstRelease: '0.3.0', state: 'provisioned', provenance: 'fixture' });
    const inventoryFile = join(root, 'inventory.json');
    json(inventoryFile, inventory);
    const prior = { releaseVersion: '0.2.0', backendGeneration: 'legacy' };
    expect(() => prepareRelease({ ...config, projectId: 'fixture-legacy',
      databaseURL: 'https://fixture-legacy-default-rtdb.europe-west1.firebasedatabase.app' }, '0.3.0', 'new', prior, root)).toThrow();
    const created = prepareRelease(config, '0.3.0', 'new', prior, root);
    const file = join(root, created.contract.rulesPath);
    const saved = readFileSync(file);
    expect(() => prepareRelease(config, '0.3.0', 'new', prior, root)).toThrow();
    expect(readFileSync(file)).toEqual(saved);
    const release = loadRelease(config, '0.3.0', root);
    expect(prepareBackend(join(root, 'backend'), release)).toEqual({
      database: { instance: 'fixture-backend-default-rtdb', rules: join(root, 'backend', 'database.rules.json') },
      auth: { providers: { anonymous: true } },
    });
    expect(readFileSync(join(root, 'backend', 'database.rules.json'))).toEqual(saved);
    const invoke = vi.fn();
    deployRelease('backend', config, 'backend-config.json', invoke);
    deployRelease('control', config, 'control-config.json', invoke);
    expect(invoke.mock.calls).toEqual([
      [['deploy', '--project', config.projectId, '--config', 'backend-config.json', '--only', 'database,auth', '--non-interactive']],
      [['deploy', '--project', config.controlProjectId, '--config', 'control-config.json', '--only', 'hosting', '--non-interactive']],
    ]);
    inventory.projects.at(-1).state = 'active';
    json(inventoryFile, inventory);
    const reused = prepareRelease(config, '0.3.1', 'reuse', { releaseVersion: '0.3.0', backendGeneration: 'g1' }, root);
    expect(reused.contract).toEqual(created.contract);
    expect(() => prepareBackend(root, loadRelease(config, '0.3.1', root))).toThrow();
    writeFileSync(file, '{}');
    expect(() => loadRelease(config, '0.3.1', root)).toThrow('хэш');
    expect(() => prepareRelease(config, '0.3.2', 'reuse', { releaseVersion: '0.3.1', backendGeneration: 'g1' }, root)).toThrow('неизменный');
    inventory.projects.at(-1).state = 'retiring';
    json(inventoryFile, inventory);
    expect(() => loadRelease(config, '0.3.0', root)).toThrow('выведено');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
