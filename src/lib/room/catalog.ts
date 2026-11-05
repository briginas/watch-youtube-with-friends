import { z } from 'zod';
import type { FirebaseConfig } from '../firebase/config';
import { roomKeySchema } from './key';
import { videoIdSchema } from '../youtube-url';
import { roomMetadataSchema } from './metadata';
import { ownGenerationSchema, localFormatVersion } from './generation';

export const catalogRoomSchema = z.object({
  key: roomKeySchema, videoId: videoIdSchema, name: roomMetadataSchema.shape.name, backendGeneration: ownGenerationSchema,
}).strict();
export const catalogEntrySchema = catalogRoomSchema.extend({
  savedAt: z.number().int().nonnegative().safe(), lastOpenedAt: z.number().int().nonnegative().safe(),
});
export type CatalogRoom = z.infer<typeof catalogRoomSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export interface CatalogSnapshot { entries: CatalogEntry[]; warning: string | null }
/** Вычисляется при чтении для popup, не сохраняется в постоянном каталоге. */
export interface CatalogPopupSnapshot extends CatalogSnapshot { tabStates: Record<string, 'current' | 'other'> }
export const catalogError = 'Не удалось обновить список комнат. Повторите действие.';

export function catalogStorageKey(config: FirebaseConfig): string {
  return `roomCatalog:v${localFormatVersion}:${config.backendGeneration}:${JSON.stringify([config.emulators, config.projectId,
    new URL(config.databaseURL).origin, new URL(config.invitationBaseUrl).href])}`;
}

export function readCatalog(value: unknown): CatalogSnapshot {
  if (value === undefined) return { entries: [], warning: null };
  const envelope = z.object({ version: z.literal(localFormatVersion), entries: z.array(z.unknown()) }).strict().safeParse(value);
  if (!envelope.success) throw new Error('Формат списка комнат не поддерживается.');
  const entries = new Map<string, CatalogEntry>();
  let damaged = false;
  for (const raw of envelope.data.entries) {
    const parsed = catalogEntrySchema.safeParse(raw);
    if (!parsed.success) { damaged = true; continue; }
    const previous = entries.get(parsed.data.key);
    if (!previous || parsed.data.lastOpenedAt > previous.lastOpenedAt) entries.set(parsed.data.key, parsed.data);
  }
  return {
    entries: [...entries.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.key.localeCompare(b.key)),
    warning: damaged ? 'Часть списка комнат не удалось прочитать.' : null,
  };
}

/** Все вызовы изменения сериализует один worker; хранилище само очередь не создаёт. */
export function createCatalogRepository(storage: {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<unknown>;
}, storageKey: string, now = Date.now) {
  const read = async () => readCatalog((await storage.get(storageKey))[storageKey]);
  async function write(entries: CatalogEntry[]) {
    await storage.set({ [storageKey]: { version: localFormatVersion, entries } });
  }
  return {
    read,
    async save(input: CatalogRoom) {
      const room = catalogRoomSchema.parse(input);
      const { entries } = await read();
      const old = entries.find(entry => entry.key === room.key);
      await write([...entries.filter(entry => entry.key !== room.key), {
        ...room, name: old?.name ?? room.name, savedAt: old?.savedAt ?? now(), lastOpenedAt: now(),
      }]);
    },
    async remove(key: string) {
      roomKeySchema.parse(key);
      const { entries } = await read();
      await write(entries.filter(entry => entry.key !== key));
    },
  };
}
