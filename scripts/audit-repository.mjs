import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const patterns = {
  'private-key': /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  'service-account': /["']type["']\s*:\s*["']service_account["']/,
  'google-api-key': /AIza[0-9A-Za-z_-]{30,}/,
  'google-token': /(?:ya29\.[A-Za-z0-9_-]{20,}|1\/\/[A-Za-z0-9_-]{30,})/,
  'github-token': /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  'aws-access-key': /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  'jwt': /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  'slack-token': /xox[baprs]-[A-Za-z0-9-]{20,}/,
  'npm-token': /npm_[A-Za-z0-9]{30,}/,
  'secret-api-key': /sk[-_](?:live[-_]|test[-_]|proj-)?[A-Za-z0-9_-]{24,}/,
  'private-home-path': /\/Users\/[A-Za-z0-9_.-]+\//,
  'operator-console': /webstore\/devconsole\//,
};

export function auditContent(path, bytes) {
  const findings = [];
  if (/(?:^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('.example') ||
      /^(?:\.local|node_modules|\.output|\.firebase|test-results|playwright-report)\//.test(path) ||
      /(?:^|\/)(?:credentials|service-account)[^/]*\.json$|\.(?:pem|p12|pfx)$/.test(path)) {
    findings.push('private-file');
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }); }
    catch { return [...findings, 'unreadable-gzip']; }
  }
  const text = bytes.toString('utf8');
  for (const [category, pattern] of Object.entries(patterns)) if (pattern.test(text)) findings.push(category);
  return findings;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export function auditRepository(ref) {
  const findings = []; let checked = 0;
  const check = (path, bytes) => {
    checked++;
    for (const category of auditContent(path, bytes)) findings.push({ path, category });
  };
  if (ref) {
    const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const seen = new Set();
    for (const revision of git('rev-list', commit).trim().split('\n')) {
      // Check every path as well as every distinct blob: identical content can
      // be committed under a safe filename and a forbidden filename.
      for (const row of git('ls-tree', '-rz', revision).split('\0').filter(Boolean)) {
        const [metadata, path] = row.split('\t'); const [mode, type, oid] = metadata.split(' ');
        if (type !== 'blob' || mode === '120000') { findings.push({ path, category: 'unsupported-git-entry' }); continue; }
        const key = `${oid}:${path}`; if (seen.has(key)) continue; seen.add(key);
        check(path, execFileSync('git', ['cat-file', 'blob', oid], { maxBuffer: 64 * 1024 * 1024 }));
      }
      // Author email is intentionally public; credential patterns still apply.
      check('(commit metadata)', Buffer.from(git('show', '-s', '--format=fuller', revision)));
    }
  } else {
    const paths = new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean));
    for (const path of paths) {
      if (!existsSync(path)) continue;
      if (!lstatSync(path).isFile()) { findings.push({ path, category: 'unsupported-file' }); continue; }
      check(path, readFileSync(path));
    }
  }
  return { checked, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--ref')) throw new Error('usage');
    const result = auditRepository(args[1]);
    for (const finding of result.findings) console.error(`${finding.category}: ${finding.path}`);
    console.log(`Repository audit: ${result.checked} items; ${result.findings.length} findings.`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    console.error('Repository audit failed. Usage: npm run repo:audit -- [--ref main]. No file contents are printed.');
    process.exitCode = 1;
  }
}
