import { expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStatus, updateStatus } from '../../scripts/service-status.mjs';
import { prepareControlHosting } from '../../scripts/release/hosting.mjs';
it('оператор проверяет TTL и причину статуса', () => {
  const value = prepareStatus('unavailable', { reason: 'quota', seconds: 3600 });
  expect(value).toMatchObject({ version: 1, state: 'unavailable', reason: 'quota' });
  expect(() => prepareStatus('busy', { retryAfterSeconds: 999 })).toThrow();
  expect(() => prepareStatus('operational', { seconds: 86401 })).toThrow();
});
it('обычный release сохраняет точный JSON оператора, без сброса объявления', () => {
  const root = mkdtempSync(join(tmpdir(), 'status-release-'));
  try {
    const source = join(root, 'source'); mkdirSync(source);
    const generations = ['one', 'two'];
    const relative = generation => `generations/${generation}/service-status.json`;
    writeFileSync(join(source, 'backend-generations.json'), JSON.stringify({ schemaVersion: 1, revision: 1,
      updatedAt: new Date().toISOString(), generations: generations.map(generation => ({ generation, firstRelease: '0.3.0', state: 'active' })),
    }));
    const incident = JSON.stringify(prepareStatus('unavailable', { reason: 'quota' }));
    for (const generation of generations) {
      mkdirSync(join(source, 'generations', generation), { recursive: true });
      writeFileSync(join(source, relative(generation)), incident);
    }
    const operational = prepareStatus('operational');
    updateStatus(source, 'one', operational);
    expect(() => updateStatus(source, '../two', operational)).toThrow();
    const directory = prepareControlHosting(root, {}, source);
    expect(JSON.parse(readFileSync(join(directory, relative('one')), 'utf8'))).toEqual(operational);
    expect(readFileSync(join(directory, relative('two')), 'utf8')).toBe(incident);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
