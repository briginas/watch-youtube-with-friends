import { spawn, spawnSync } from 'node:child_process';
import { dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Homebrew устанавливает versioned JDK без изменения системного /usr/bin/java.
const javaCandidates = [
  ...(process.env.JAVA_HOME ? [resolve(process.env.JAVA_HOME, 'bin/java')] : []),
  'java',
  '/opt/homebrew/opt/openjdk@21/bin/java',
  '/usr/local/opt/openjdk@21/bin/java',
];
const java = javaCandidates.find((candidate) => {
  const result = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
  const major = /version "(\d+)/.exec(`${result.stderr}${result.stdout}`)?.[1];
  return result.status === 0 && Number(major) >= 21;
});

if (!java) {
  console.error('Нужна Java 21+. На macOS: brew install openjdk@21. Либо задайте JAVA_HOME.');
  process.exit(1);
}

const env = { ...process.env };
if (java !== 'java') env.PATH = `${dirname(java)}${delimiter}${env.PATH ?? ''}`;
const cli = fileURLToPath(new URL('../node_modules/firebase-tools/lib/bin/firebase.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
