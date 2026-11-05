import { expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlHostingConfig, prepareControlHosting } from '../../scripts/release/hosting.mjs';
import { prepareStatus } from '../../scripts/service-status.mjs';
it('control output сохраняет retired и все инциденты, не включает Auth/Database', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-test-'));
  try {
    expect(() => prepareControlHosting(join(root, 'absent-output'), {}, join(root, 'missing'))).toThrow('npm run config:init');
    const source = join(root, 'source'); mkdirSync(source);
    const registry = { schemaVersion: 1, revision: 2, updatedAt: '2026-11-04T00:00:00Z', generations: [
      { generation: 'old', firstRelease: '0.1.0', state: 'retired', retiredAt: '2026-11-03T00:00:00Z' },
      { generation: 'new', firstRelease: '0.3.0', state: 'active' }] };
    writeFileSync(join(source, 'backend-generations.json'), JSON.stringify(registry));
    for (const generation of ['old', 'new']) {
      mkdirSync(join(source, 'generations', generation), { recursive: true });
      writeFileSync(join(source, 'generations', generation, 'service-status.json'), JSON.stringify(prepareStatus('unavailable', { reason: 'quota' })));
    }
    const directory = prepareControlHosting(join(root, 'output'), {}, source);
    expect(JSON.parse(readFileSync(join(directory, 'backend-generations.json')))).toEqual(registry);
    expect(readFileSync(join(directory, 'generations/old/service-status.json'), 'utf8')).toBe(readFileSync(join(source, 'generations/old/service-status.json'), 'utf8'));
    const config = controlHostingConfig({ projectId: 'fixture-backend', controlProjectId: 'fixture-control', invitationBaseUrl: 'https://fixture-control.web.app' }, directory);
    expect(Object.keys(config)).toEqual(['hosting']); expect(config.hosting.site).toBe('fixture-control');
    expect(config.hosting.headers.some(item => item.headers.some(header => header.key === 'Cache-Control' && header.value === 'no-store'))).toBe(true);
    expect(() => controlHostingConfig({ projectId: 'fixture-control', controlProjectId: 'fixture-control', invitationBaseUrl: 'https://fixture-control.web.app' }, directory)).toThrow();
    expect(() => prepareControlHosting(join(root, 'rollback'), {}, source, { ...registry, revision: 3 })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
