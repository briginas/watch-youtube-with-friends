import { randomUUID } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { assertRegistryUpdate, compareVersions, generationSchema, inventorySchema, parseRegistry } from '../../src/lib/backend-generations.ts';
import { json, readJson } from './generation.mjs';

const working = new Set(['provisioned', 'active', 'retiring']);
const fail = reason => new Error('Rotation: ' + reason);
function registry(value) {
  const result = parseRegistry(value);
  if (!result) throw fail('реестр не прошёл проверку');
  return result;
}

function verifyProjects(plan, observed) {
  if (!Array.isArray(observed) || new Set(observed.map(item => item.projectId)).size !== observed.length ||
      observed.length !== plan.projects.length) throw fail('фактический список проектов расходится с планом');
  const live = id => observed.find(item => item.projectId === id);
  for (const expected of plan.projects) {
    const actual = live(expected.projectId);
    if (!actual || actual.role !== expected.role || actual.generation !== expected.generation)
      throw fail('проект, роль или поколение не подтверждены');
    if (expected.projectId === plan.candidate.projectId) {
      if (actual.state === 'NOT_FOUND' || (actual.state === 'ACTIVE' && actual.planId === plan.id &&
          ['provision', 'complete'].includes(plan.stage))) continue;
    } else if (expected.projectId === plan.victim?.projectId) {
      if (actual.state === 'ACTIVE' && ['publish', 'delete'].includes(plan.stage)) continue;
      if (['DELETE_REQUESTED', 'DELETED'].includes(actual.state) && ['delete', 'provision', 'complete'].includes(plan.stage)) continue;
    } else {
      const states = expected.role !== 'backend' || working.has(expected.state) ? ['ACTIVE']
        : expected.state === 'delete-requested' ? ['DELETE_REQUESTED', 'DELETED']
          : expected.state === 'deleted' ? ['DELETED'] : ['NOT_FOUND'];
      if (states.includes(actual.state)) continue;
    }
    throw fail('неожиданное состояние проекта, включая возможное восстановление');
  }
  return live;
}

export function planRotation(input, candidateId, published, observed, now = Date.now()) {
  const inventory = inventorySchema.parse(input);
  generationSchema.parse(candidateId);
  const before = registry(published);
  const candidate = inventory.projects.find(item => item.role === 'backend' && item.generation === candidateId && item.state === 'planned');
  const control = inventory.projects.find(item => item.role === 'control');
  if (!candidate || !control || inventory.projects.filter(item => item.role === 'control').length !== 1 ||
      before.generations.some(item => item.generation === candidateId)) throw fail('кандидат или control project не подтверждены');
  for (const entry of before.generations) {
    const project = inventory.projects.find(item => item.role === 'backend' && item.generation === entry.generation);
    if (!project || project.firstRelease !== entry.firstRelease ||
        (entry.state === 'active' ? !working.has(project.state) : !['retiring', 'delete-requested', 'deleted'].includes(project.state)))
      throw fail('инвентарь противоречит опубликованному реестру');
  }
  const current = inventory.projects.filter(item => item.role === 'backend' && working.has(item.state));
  const victim = current.length === 3 ? current.sort((a, b) => compareVersions(a.firstRelease, b.firstRelease))[0] : null;
  if (victim && before.generations.some(entry => entry.generation === victim.generation && entry.state === 'retired'))
    throw fail('для выбранного retired поколения нужен исходный план');
  let retired = null;
  if (victim) {
    const retiredAt = new Date(Math.max(now, Date.parse(before.updatedAt))).toISOString();
    retired = { ...before, revision: before.revision + 1, updatedAt: retiredAt,
      generations: [...before.generations.filter(item => item.generation !== victim.generation),
        { generation: victim.generation, firstRelease: victim.firstRelease, state: 'retired', retiredAt }],
    };
    assertRegistryUpdate(before, retired);
  }
  const plan = { schemaVersion: 1, id: randomUUID(), control, candidate, victim, before, retired,
    projects: inventory.projects, stage: victim ? 'publish' : 'provision', completed: [] };
  verifyProjects(plan, observed);
  return plan;
}

export async function runRotation(plan, adapter, save) {
  const stages = plan.victim ? ['publish', 'delete', 'provision', 'complete'] : ['provision', 'complete'];
  const index = stages.indexOf(plan.stage);
  if (plan.schemaVersion !== 1 || !/^[a-f\d-]{36}$/.test(plan.id) || index < 0 ||
      !isDeepStrictEqual(plan.completed, stages.slice(0, index))) throw fail('журнал плана не прошёл проверку');
  const baseline = plan.projects.map(({ role, projectId, generation, state }) => ({
    role, projectId, generation, state: role !== 'backend' || working.has(state) ? 'ACTIVE'
      : state === 'planned' ? 'NOT_FOUND' : state === 'deleted' ? 'DELETED' : 'DELETE_REQUESTED',
  }));
  const expected = planRotation({ schemaVersion: 1, projects: plan.projects }, plan.candidate.generation,
    plan.before, baseline, Date.parse(plan.retired?.updatedAt ?? plan.before.updatedAt));
  for (const key of ['control', 'candidate', 'victim', 'retired'])
    if (!isDeepStrictEqual(plan[key], expected[key])) throw fail('цель или снимок плана были изменены');
  const checkpoint = stage => {
    plan.completed.push(plan.stage);
    plan.stage = stage;
    save(plan);
  };
  const call = async (operation, ...args) => {
    try { return await adapter[operation](...args); }
    catch { throw fail('операция ' + operation + ' не подтверждена, сохранён тот же план'); }
  };
  const readRegistry = async () => registry(await call('readRegistry', plan.control.projectId));
  const projects = async () => verifyProjects(plan, await call('observe', plan.projects.map(item => item.projectId)));
  const confirmQuota = async () => {
    const result = await call('quota', plan.candidate.projectId);
    if (result?.canCreate !== true) throw fail('облачная квота не подтверждена, DELETE_REQUESTED может занимать место');
  };
  const verifyRegistry = async expected => {
    if (!isDeepStrictEqual(await readRegistry(), expected)) throw fail('публичная revision или содержимое реестра изменились');
  };
  if (plan.stage === 'publish') {
    await projects();
    const existing = await readRegistry();
    if (isDeepStrictEqual(existing, plan.before)) {
      await confirmQuota();
      await call('publish', plan.control.projectId, plan.retired, plan.before.revision);
    } else if (!isDeepStrictEqual(existing, plan.retired)) throw fail('публичная revision или содержимое реестра изменились');
    await verifyRegistry(plan.retired);
    checkpoint('delete');
  }
  if (plan.stage === 'delete') {
    await verifyRegistry(plan.retired);
    const projectId = plan.victim.projectId;
    if ((await projects())(projectId).state === 'ACTIVE') {
      await confirmQuota();
      await call('deleteProject', projectId);
    }
    if ((await projects())(projectId).state === 'ACTIVE') throw fail('удаление точного проекта не подтверждено');
    checkpoint('provision');
  }
  if (plan.stage === 'provision') {
    await verifyRegistry(plan.retired ?? plan.before);
    const projectId = plan.candidate.projectId;
    if ((await projects())(projectId).state === 'NOT_FOUND') {
      await confirmQuota();
      await call('provision', projectId, plan.candidate.generation, plan.id);
    }
    if ((await projects())(projectId).state !== 'ACTIVE') throw fail('создание кандидата не подтверждено');
    checkpoint('complete');
  }
  if (plan.stage !== 'complete') throw fail('неизвестный этап');
  await projects();
  return plan;
}

export async function withRotationFile(path, callback) {
  const lock = path + '.lock';
  let descriptor;
  try { descriptor = openSync(lock, 'wx'); }
  catch { throw fail('локальный план уже выполняется или файл блокировки недоступен'); }
  try {
    return await callback(() => readJson(path), plan => {
      const pending = path + '.pending';
      json(pending, plan, { mode: 0o600 });
      renameSync(pending, path);
    });
  } finally {
    closeSync(descriptor);
    rmSync(lock);
  }
}

export async function resumeRotation(path, adapter) {
  return withRotationFile(path, (load, save) => runRotation(load(), adapter, save));
}
