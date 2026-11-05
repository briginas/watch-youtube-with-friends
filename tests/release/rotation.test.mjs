import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { json, readJson } from '../../scripts/release/generation.mjs';
import { planRotation, runRotation, withRotationFile } from '../../scripts/release/rotation.mjs';

function scenario(free = false) {
  const inventory = readJson('tests/fixtures/generations/inventory.json');
  if (free) inventory.projects = inventory.projects.filter(item => item.generation !== 'g3');
  const published = { schemaVersion: 1, revision: 1, updatedAt: '2025-01-01T00:00:00Z',
    generations: inventory.projects.filter(item => item.state === 'active').map(({ generation, firstRelease }) =>
      ({ generation, firstRelease, state: 'active' })),
  };
  const observed = inventory.projects.map(({ projectId, role, generation, state }) =>
    ({ projectId, role, generation, state: state === 'planned' ? 'NOT_FOUND' : 'ACTIVE' }));
  const calls = [];
  const adapter = {
    registry: published, canCreate: true,
    readRegistry: async () => structuredClone(adapter.registry),
    observe: async () => structuredClone(observed),
    quota: async () => ({ canCreate: adapter.canCreate }),
    publish: async (projectId, next, revision) => {
      expect(revision).toBe(adapter.registry.revision);
      calls.push(['publish', projectId]);
      adapter.registry = structuredClone(next);
    },
    deleteProject: async projectId => {
      calls.push(['delete', projectId]);
      observed.find(item => item.projectId === projectId).state = 'DELETE_REQUESTED';
    },
    provision: async (projectId, generation, planId) => {
      calls.push(['provision', projectId]);
      expect(observed.filter(item => item.role === 'backend' && item.state === 'ACTIVE')).toHaveLength(2);
      Object.assign(observed.find(item => item.projectId === projectId), { state: 'ACTIVE', generation, planId });
    },
  };
  return { inventory, published, observed, calls, adapter, plan: planRotation(inventory, 'g4', published, observed) };
}

it.each([false, true])('соблюдает порядок и лимит, свободное место = %s', async free => {
  const { plan, adapter, calls } = scenario(free);
  const save = vi.fn();
  expect(plan.victim?.generation).toBe(free ? undefined : 'g1');
  await runRotation(plan, adapter, save);
  await runRotation(plan, adapter, save);
  const provision = [['provision', 'fixture-backend-four']];
  expect(calls).toEqual(free ? provision : [['publish', 'fixture-control'], ['delete', 'fixture-backend-one'], ...provision]);
  expect(plan.completed).toEqual(free ? ['provision'] : ['publish', 'delete', 'provision']);
});

it('после неизвестных исходов сверяет факты и не меняет жертву, 403 скрывает вывод', async () => {
  const { plan, adapter, calls, observed } = scenario();
  const save = vi.fn();
  const publish = adapter.publish, remove = adapter.deleteProject, provision = adapter.provision;
  adapter.publish = async (...args) => { await publish(...args); throw Error('private detail'); };
  await expect(runRotation(plan, adapter, save)).rejects.toThrow('publish не подтверждена');
  expect(plan.stage).toBe('publish');
  adapter.deleteProject = async () => { throw Error('403 private detail'); };
  await expect(runRotation(plan, adapter, save)).rejects.toThrow(/^Rotation: операция deleteProject не подтверждена, сохранён тот же план$/);
  expect(plan.stage).toBe('delete');
  adapter.deleteProject = async (...args) => { await remove(...args); adapter.canCreate = false; };
  await expect(runRotation(plan, adapter, save)).rejects.toThrow('облачная квота');
  expect(plan.stage).toBe('provision');
  const victim = observed.find(item => item.projectId === plan.victim.projectId);
  victim.state = 'ACTIVE';
  await expect(runRotation(plan, adapter, save)).rejects.toThrow('восстановление');
  victim.state = 'DELETE_REQUESTED';
  adapter.canCreate = true;
  adapter.provision = async () => { throw Error('temporary'); };
  await expect(runRotation(plan, adapter, save)).rejects.toThrow('provision не подтверждена');
  adapter.provision = async (...args) => { await provision(...args); throw Error('unknown outcome'); };
  await expect(runRotation(plan, adapter, save)).rejects.toThrow('provision не подтверждена');
  await runRotation(plan, adapter, save);
  expect(calls.map(([name]) => name)).toEqual(['publish', 'delete', 'provision']);
});

it('останавливается при несовпадении роли или revision и сериализует файл', async () => {
  const { plan, adapter, calls, observed, inventory, published } = scenario();
  const root = mkdtempSync(join(tmpdir(), 'rotation-'));
  try {
    const path = join(root, 'plan.json');
    expect(() => planRotation(inventory, 'g4', published, observed.slice(1))).toThrow('список проектов');
    await withRotationFile(path, async (load, save) => {
      save(plan);
      expect(load()).toEqual(plan);
      await expect(withRotationFile(path, vi.fn())).rejects.toThrow('уже выполняется');
      adapter.registry = { ...published, revision: 2 };
      await expect(runRotation(load(), adapter, save)).rejects.toThrow('revision');
      expect(load()).toEqual(plan);
    });
    expect(calls).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('CLI сохраняет читаемый план для фактических snapshots и не перезаписывает журнал', () => {
  const { inventory, published, observed } = scenario();
  const cwd = mkdtempSync(join(tmpdir(), 'rotation-cli-'));
  try {
    json(join(cwd, 'inventory.json'), inventory);
    json(join(cwd, 'registry.json'), published);
    json(join(cwd, 'observed.json'), observed);
    const args = [resolve('scripts/rotation.mjs'), 'plan', 'g4', 'registry.json', 'observed.json', 'inventory.json'];
    const execute = () => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    const output = JSON.parse(execute());
    expect(output).toMatchObject({ stage: 'publish', candidate: 'fixture-backend-four', victim: 'fixture-backend-one' });
    expect(() => execute()).toThrow('сохранённый план уже существует');
    expect(readJson(join(cwd, '.output/rotation/plan.json')).id).toBe(output.id);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
