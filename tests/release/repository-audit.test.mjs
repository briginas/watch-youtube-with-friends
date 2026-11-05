import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { auditContent } from '../../scripts/audit-repository.mjs';

it('проверяет secrets в тексте и gzip без значений в находках', () => {
  const secret = 'gh' + 'p_' + 'Z'.repeat(36);
  for (const bytes of [Buffer.from(secret), gzipSync(secret)]) {
    const findings = auditContent('report.json', bytes);
    expect(findings).toEqual(['github-token']);
    expect(JSON.stringify(findings)).not.toContain(secret);
  }
  expect(auditContent('key.txt', Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----'))).toContain('private-key');
  expect(auditContent('broken.gz', Buffer.from([0x1f, 0x8b, 0x00]))).toContain('unreadable-gzip');
});
it('не позволяет добавить локальные файлы даже без credentials', () => {
  for (const path of ['.env', '.env.cloud', '.local/deployment/inventory.json', 'service-account.json']) {
    expect(auditContent(path, Buffer.from('{}'))).toContain('private-file');
  }
  expect(auditContent('.env.production.example', Buffer.from('WXT_FIREBASE_API_KEY=\n'))).toEqual([]);
});
