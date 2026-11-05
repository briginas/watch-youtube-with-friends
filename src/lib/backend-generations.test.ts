import { describe, expect, it } from 'vitest';
import { assertRegistryUpdate, compareVersions, generationSchema, inventorySchema, parseRegistry, releaseDescriptorSchema, releaseVersionSchema } from './backend-generations';
import fixture from '../../tests/fixtures/generations/inventory.json';

const registry = { schemaVersion: 1 as const, revision: 1, updatedAt: '2020-01-01T00:00:00Z',
  generations: [{ generation: 'g1', firstRelease: '0.9.0', state: 'retired' as const, retiredAt: '2020-01-01T00:00:00Z' }] };
describe('generation contracts', () => {
  it('инвентарь различает данные runbook, живые проекты и тестовые записи', () => {
    const inventory = { schemaVersion: 1, projects: [
      { role: 'backend', projectId: 'fixture-legacy', generation: 'legacy', firstRelease: '0.1.0', state: 'active', provenance: 'runbook' },
      { role: 'backend', projectId: 'fixture-live', generation: 'g1', firstRelease: '0.2.1', state: 'active', provenance: 'live', observedAt: '2026-11-04T00:00:00Z' },
    ] };
    expect(inventorySchema.parse(inventory).projects).toEqual(inventory.projects);
    const backends = inventorySchema.parse(inventory).projects.filter(item => item.role === 'backend');
    expect(backends.find(item => item.generation === 'legacy')).toMatchObject({ provenance: 'runbook' });
    expect(backends.filter(item => item.generation !== 'legacy' && item.state === 'active').every(item => item.provenance === 'live')).toBe(true);
    expect(inventorySchema.parse(fixture).projects.filter(item => item.role === 'backend' && item.state === 'planned')).toHaveLength(1);
  });
  it('сравнивает версии численно и ограничивает идентификаторы', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.1', '0.10.0')).toBe(1);
    for (const value of ['01.0.0', '1.2', '1.0.0-beta', '9007199254740992.0.0']) expect(releaseVersionSchema.safeParse(value).success).toBe(false);
    for (const value of ['g/2', 'https://other', 'G1', 'g'.repeat(33)]) expect(generationSchema.safeParse(value).success).toBe(false);
  });
  it('постоянная retired отметка не имеет ежедневного TTL', () => {
    expect(parseRegistry(registry)).toEqual(registry);
    const now = Date.now();
    expect(parseRegistry({ ...registry, updatedAt: new Date(now + 300_001).toISOString() }, now)).toBeNull();
    for (const value of [{ ...registry, schemaVersion: 2 }, { ...registry, generations: [...registry.generations, ...registry.generations] },
      { ...registry, databaseURL: 'https://attacker' }, { ...registry, updatedAt: 'invalid' },
      { ...registry, updatedAt: '2019-01-01T00:00:00Z' }]) expect(parseRegistry(value)).toBeNull();
  });
  it('запрещает возврат retired в active, удаление истории и повтор revision', () => {
    expect(() => assertRegistryUpdate(registry, { ...registry, revision: 2 })).not.toThrow();
    for (const next of [registry, { ...registry, revision: 2, generations: [] }, { ...registry, revision: 2,
      generations: [{ generation: 'g1', firstRelease: '0.9.0', state: 'active' as const }] }])
      expect(() => assertRegistryUpdate(registry, next)).toThrow();
  });
  it('не позволяет выдать QA/control за backend и дублировать роли проектов', () => {
    expect(inventorySchema.safeParse({ schemaVersion: 1, projects: [{ role: 'qa', projectId: 'fixture-qa', generation: 'g1' }] }).success).toBe(false);
    expect(inventorySchema.safeParse({ schemaVersion: 1, projects: [{ role: 'qa', projectId: 'fixture-qa' }, { role: 'control', projectId: 'fixture-qa' }] }).success).toBe(false);
    expect(inventorySchema.safeParse({ schemaVersion: 1, projects: [{ role: 'backend', projectId: 'fixture-backend', generation: 'g1', firstRelease: '0.1.0', state: 'active', provenance: 'live' }] }).success).toBe(false);
  });
  it('требует явный предыдущий релиз и согласованное отображение проектов', () => {
    const descriptor = { schemaVersion: 1, releaseVersion: '0.3.0', firstRelease: '0.3.0', mode: 'new', backendGeneration: 'g2',
      previous: { releaseVersion: '0.2.0', backendGeneration: 'legacy' },
      backend: { projectId: 'fixture-backend', databaseOrigin: 'https://fixture-backend-default-rtdb.europe-west1.firebasedatabase.app' },
      control: { projectId: 'fixture-control', origin: 'https://fixture-control.web.app' },
      contract: { rulesPath: 'rules.json', rulesSha256: 'a'.repeat(64), schemaPath: 'schema.json', schemaSha256: 'b'.repeat(64) } };
    expect(releaseDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const change of [{ previous: undefined }, { backendGeneration: 'legacy' }, { mode: 'reuse' }, { releaseVersion: '0.1.0' },
      { control: { projectId: 'fixture-backend', origin: 'https://fixture-backend.web.app' } }])
      expect(releaseDescriptorSchema.safeParse({ ...descriptor, ...change }).success).toBe(false);
  });
});
