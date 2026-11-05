import { readFileSync } from 'node:fs';
import { generationSchema } from '../src/lib/backend-generations.ts';

/** Только новый контракт. Исторические поколения deploy используют снимок, а не этот генератор. */
export function generationRules(generation, { probes = false } = {}) {
  generationSchema.parse(generation);
  if (generation === 'legacy') throw new Error('Release: legacy Rules доступны только как сохранённый снимок.');
  const rules = JSON.parse(readFileSync(new URL('../firebase/emulator.database.rules.json', import.meta.url), 'utf8'));
  rules.rules.rooms.$key.metadata.backendGeneration['.validate'] = `newData.val() === '${generation}'`;
  if (!probes) delete rules.rules._probes;
  return rules;
}
