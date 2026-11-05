import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseRegistry, assertRegistryUpdate } from '../../src/lib/backend-generations.ts';
import { serviceStatusSchema } from '../../src/lib/service-status.ts';
import { readJson } from './generation.mjs';

export function prepareHosting(output, values, sourceDirectory = 'firebase/hosting') {
  const email = values.RELEASE_SUPPORT_EMAIL?.trim() ?? '';
  if (email && !/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(email)) {
    throw new Error('Release: некорректный RELEASE_SUPPORT_EMAIL.');
  }
  const state = values.RELEASE_STORE_PUBLISHED ?? '0';
  const id = values.RELEASE_STORE_ID ?? '';
  if (!['0', '1'].includes(state) || (id && !/^[a-p]{32}$/.test(id)) || (state === '1' && !id)) {
    throw new Error('Release: некорректное состояние Chrome Web Store.');
  }
  const directory = join(output, 'hosting');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  cpSync(sourceDirectory, directory, { recursive: true });
  const source = readFileSync(join(directory, 'index.html'), 'utf8');
  const block = state === '1'
    ? `<p><a href="https://chromewebstore.google.com/detail/${id}" rel="noreferrer">Установить из Chrome Web Store</a></p>`
    : '<p>Расширение готовится к публикации в Chrome Web Store. Установка станет доступна после проверки и публикации.</p>';
  writeFileSync(join(directory, 'index.html'), source.replace(/<!-- RELEASE_INSTALLATION -->[\s\S]*?<!-- \/RELEASE_INSTALLATION -->/, block));
  const contact = email ? `<a href="mailto:${email}" rel="noreferrer">${email}</a>` : 'Контакт поддержки не настроен.';
  for (const name of ['index.html', 'privacy.html']) {
    const path = join(directory, name);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/<!-- SUPPORT_CONTACT -->[\s\S]*?<!-- \/SUPPORT_CONTACT -->/, contact));
  }
  return directory;
}

/** Полный источник control: реестр и статусы всех поколений. Никогда не копирует QA status. */
export function prepareControlHosting(output, values, controlSource = '.local/deployment/control', previousRegistry) {
  const registry = parseRegistry(readJson(join(controlSource, 'backend-generations.json')));
  if (!registry) throw new Error('Release: некорректный реестр поколений.');
  if (previousRegistry && !isDeepStrictEqual(previousRegistry, registry)) assertRegistryUpdate(previousRegistry, registry);
  const directory = prepareHosting(output, values);
  rmSync(join(directory, 'generations'), { recursive: true, force: true });
  rmSync(join(directory, 'service-status.json'), { force: true });
  cpSync(controlSource, directory, { recursive: true });
  for (const entry of registry.generations) {
    const path = join(directory, 'generations', entry.generation, 'service-status.json');
    if (!existsSync(path)) throw new Error('Release: отсутствует статус поколения в полном control source.');
    if (!serviceStatusSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success)
      throw new Error('Release: некорректный статус поколения.');
  }
  return directory;
}

export function controlHostingConfig(config, directory) {
  if (!config.controlProjectId || config.controlProjectId === config.projectId ||
      new URL(config.invitationBaseUrl).hostname !== `${config.controlProjectId}.web.app`)
    throw new Error('Release: требуется отдельный control Hosting project.');
  const local = JSON.parse(readFileSync('firebase.json', 'utf8'));
  return { hosting: { ...local.hosting, site: config.controlProjectId, public: directory } };
}
