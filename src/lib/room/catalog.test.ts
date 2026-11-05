import { describe, expect, it } from 'vitest';
import { catalogStorageKey, createCatalogRepository, readCatalog } from './catalog';

const a = { key: 'a'.repeat(64), videoId: 'aqz-KE-bpKQ', name: 'A', backendGeneration: 'emulator-v1' };
const b = { ...a, key: 'b'.repeat(64), name: 'B' };
function setup() {
  const data: Record<string, unknown> = {};
  let fail = false;
  let tick = 0;
  const storage = {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => { if (fail) throw new Error('quota'); Object.assign(data, values); },
  };
  return { data, storage, fail: () => { fail = true; }, repo: createCatalogRepository(storage, 'catalog', () => ++tick) };
}

describe('локальный каталог', () => {
  it('сохраняет две комнаты одного видео, дедуплицирует и сохраняет исходное имя/дату', async () => {
    const { repo } = setup();
    await repo.save(a);
    const first = (await repo.read()).entries[0]!;
    await repo.save(b);
    await repo.save({ ...a, name: 'Переименование' });
    expect((await repo.read()).entries).toEqual([
      { ...first, lastOpenedAt: expect.any(Number) }, expect.objectContaining(b),
    ]);
    expect((await repo.read()).entries[0]!.lastOpenedAt).toBeGreaterThan(first.lastOpenedAt);
    await repo.remove(a.key);
    expect((await repo.read()).entries).toEqual([expect.objectContaining(b)]);
  });

  it('изолирует namespace сервера и профиля', async () => {
    const config = { apiKey: 'public', projectId: 'demo-a', databaseURL: 'https://demo-a.firebaseio.com/',
      invitationBaseUrl: 'http://127.0.0.1:5002/', emulators: true, backendGeneration: 'emulator-v1', controlProjectId: 'demo-watch-together' };
    const { storage } = setup();
    const key = catalogStorageKey(config);
    await createCatalogRepository(storage, key).save(a);
    for (const change of [{ projectId: 'demo-b' }, { databaseURL: 'https://demo-b.firebaseio.com' },
      { invitationBaseUrl: 'https://example.org/' }, { emulators: false }, { backendGeneration: 'other' }]) {
      expect((await createCatalogRepository(storage, catalogStorageKey({ ...config, ...change })).read()).entries).toEqual([]);
    }
    expect((await createCatalogRepository(setup().storage, key).read()).entries).toEqual([]);
    expect(catalogStorageKey({ ...config, apiKey: 'rotated-public-key' })).toBe(key);
  });

  it('не читает прежний namespace и не сохраняет совпавший ключ другого поколения', async () => {
    const state = setup();
    state.data.roomCatalog = { version: 1, entries: [a] };
    expect((await state.repo.read()).entries).toEqual([]);
    await expect(state.repo.save({ ...a, backendGeneration: 'other' })).rejects.toThrow();
  });

  it('не прячет корректные записи из-за повреждённой; сортировка при равенстве стабильна', () => {
    const entries = [b, a].map(room => ({ ...room, savedAt: 1, lastOpenedAt: 1 }));
    const result = readCatalog({ version: 2, entries: [null, ...entries] });
    expect(result.entries.map(entry => entry.key)).toEqual([a.key, b.key]);
    expect(result.warning).toContain('Часть списка');
  });

  it('отказ записи и неизвестный формат не повреждают сохранённые данные', async () => {
    const state = setup();
    await state.repo.save(a);
    const original = structuredClone(state.data);
    state.fail();
    await expect(state.repo.save(b)).rejects.toThrow('quota');
    await expect(state.repo.remove(a.key)).rejects.toThrow('quota');
    expect(state.data).toEqual(original);
    state.data.catalog = { version: 99, entries: [] };
    await expect(state.repo.save(a)).rejects.toThrow('не поддерживается');
    expect(state.data.catalog).toEqual({ version: 99, entries: [] });
  });
});
