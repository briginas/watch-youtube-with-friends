import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './release/generation.mjs';
import { planRotation, resumeRotation, withRotationFile } from './release/rotation.mjs';

const journal = resolve('.output/rotation/plan.json');
const [command, candidate, published, observed, inventory = '.local/deployment/generations/inventory.json'] = process.argv.slice(2);
try {
  if (command === 'plan' && candidate && published && observed) {
    mkdirSync(dirname(journal), { recursive: true });
    await withRotationFile(journal, (_load, save) => {
      if (existsSync(journal)) throw new Error('Rotation: сохранённый план уже существует.');
      save(planRotation(readJson(inventory), candidate, readJson(published), readJson(observed)));
    });
  } else if (command === 'resume' && candidate && !published) {
    const adapter = (await import(pathToFileURL(resolve(candidate)).href)).default;
    await resumeRotation(journal, adapter);
  } else throw new Error('Rotation: команда plan <generation> <registry.json> <observed.json> [inventory.json] либо resume <adapter.mjs>.');
  const plan = readJson(journal);
  console.log(JSON.stringify({ id: plan.id, stage: plan.stage, candidate: plan.candidate.projectId,
    victim: plan.victim?.projectId ?? null, completed: plan.completed }));
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Rotation:') ? error.message
    : 'Rotation: проверка не пройдена. Значения и вывод адаптера скрыты.');
  if (existsSync(journal)) {
    try {
      const plan = readJson(journal);
      const id = value => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value) ? value : null;
      const stage = ['publish', 'delete', 'provision', 'complete'].includes(plan.stage) ? plan.stage : 'invalid';
      console.error(JSON.stringify({ stage, candidate: id(plan.candidate?.projectId), victim: id(plan.victim?.projectId) }));
    } catch { /* Повреждённый журнал разбирается отдельно. */ }
  }
  process.exitCode = 1;
}
