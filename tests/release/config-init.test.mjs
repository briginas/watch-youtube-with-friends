import { expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeConfig } from '../../scripts/config-init.mjs';
import { loadRelease } from '../../scripts/release/generation.mjs';

it('инициализация повторяема и не подмешивает примеры в существующее развёртывание', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-init-'));
  try {
    cpSync('config', join(root, 'config'), { recursive: true });
    for (const file of ['.env.example', '.env.production.example']) cpSync(file, join(root, file));
    expect(initializeConfig(root).length).toBeGreaterThan(2);
    const env = join(root, '.env.cloud'); writeFileSync(env, 'operator settings');
    const inventory = join(root, '.local/deployment/generations/inventory.json');
    writeFileSync(inventory, 'operator inventory');
    rmSync(join(root, '.local/deployment/control'), { recursive: true });
    expect(initializeConfig(root)).toEqual([]);
    expect(readFileSync(env, 'utf8')).toBe('operator settings');
    expect(readFileSync(inventory, 'utf8')).toBe('operator inventory');
    expect(() => loadRelease({}, '0.2.5', join(root, 'absent'))).toThrow('npm run config:init');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
