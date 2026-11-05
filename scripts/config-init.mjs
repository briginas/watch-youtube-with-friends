import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Never replace operator data, even when initialization is repeated.
export function initializeConfig(root = '.') {
  const created = [];
  const copyMissing = (source, destination) => {
    mkdirSync(dirname(destination), { recursive: true });
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      created.push(destination);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  const copyTree = (source, destination) => {
    // An existing deployment tree belongs to the operator: do not seed missing
    // example generations into a live deployment on a later initialization.
    if (existsSync(destination)) return;
    const visit = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(from, entry.name), join(to, entry.name));
        else if (entry.isFile()) copyMissing(join(from, entry.name), join(to, entry.name));
      }
    };
    visit(source, destination);
  };
  copyMissing(join(root, '.env.example'), join(root, '.env.cloud'));
  copyMissing(join(root, '.env.production.example'), join(root, '.env.production'));
  copyTree(join(root, 'config/deployment.example'), join(root, '.local/deployment'));
  return created;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  initializeConfig();
  console.log('Config: локальные примеры созданы, существующие файлы сохранены. Заполните .env.cloud/.env.production и .local/deployment по docs/configuration.md.');
}
