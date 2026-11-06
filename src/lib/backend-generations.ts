import { z } from 'zod';

export const generationSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const releaseVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine(value => value.split('.').every(part => Number.isSafeInteger(Number(part))));
export function compareVersions(a: string, b: string): number {
  const left = releaseVersionSchema.parse(a).split('.').map(Number);
  const right = releaseVersionSchema.parse(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
}
const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const time = z.iso.datetime();
const entry = { generation: generationSchema, firstRelease: releaseVersionSchema };
export const registryEntrySchema = z.discriminatedUnion('state', [
  z.object({ ...entry, state: z.literal('active') }).strict(),
  z.object({ ...entry, state: z.literal('retired'), retiredAt: time }).strict(),
]);
export const registrySchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive().safe(), updatedAt: time,
  generations: z.array(registryEntrySchema),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.generations.map(item => item.generation)).size !== value.generations.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate generation' });
  if (value.generations.filter(item => item.state === 'active').length > 3)
    ctx.addIssue({ code: 'custom', message: 'Backend limit exceeded' });
  for (const item of value.generations) if (item.state === 'retired' && Date.parse(item.retiredAt) > Date.parse(value.updatedAt))
    ctx.addIssue({ code: 'custom', message: 'Retirement after registry update' });
});
export type GenerationRegistry = z.infer<typeof registrySchema>;
export type RegistryResult = GenerationRegistry | null;
export function parseRegistry(value: unknown, now = Date.now()): RegistryResult {
  const parsed = registrySchema.safeParse(value);
  return parsed.success && Date.parse(parsed.data.updatedAt) <= now + 300_000 ? parsed.data : null;
}
/** Проверяется при каждой публикации, включая откат Hosting. */
export function assertRegistryUpdate(previous: GenerationRegistry, next: GenerationRegistry): void {
  registrySchema.parse(previous); registrySchema.parse(next);
  if (next.revision <= previous.revision || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt))
    throw new Error('Registry revision/time must increase');
  for (const old of previous.generations) {
    const current = next.generations.find(item => item.generation === old.generation);
    if (!current || old.firstRelease !== current.firstRelease || (old.state === 'retired' &&
        (current.state !== 'retired' || current.retiredAt !== old.retiredAt)))
      throw new Error('Generation history is immutable');
  }
}

const project = z.discriminatedUnion('role', [
  z.object({ role: z.enum(['qa', 'control']), projectId }).strict(),
  z.object({ role: z.literal('backend'), projectId, ...entry,
    state: z.enum(['planned', 'provisioned', 'active', 'retiring', 'delete-requested', 'deleted']),
    provenance: z.enum(['runbook', 'live', 'fixture']), observedAt: time.optional(),
  }).strict().refine(value => value.provenance !== 'live' || value.observedAt !== undefined,
    'Live observations require a timestamp'),
]);
export const inventorySchema = z.object({ schemaVersion: z.literal(1), projects: z.array(project) }).strict()
  .superRefine((value, ctx) => {
    for (const key of ['projectId', 'generation', 'firstRelease'] as const) {
      const values = value.projects.flatMap(item => key in item ? [item[key as keyof typeof item]] : []);
      if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${key}` });
    }
    if (value.projects.filter(item => item.role === 'backend' && ['provisioned', 'active', 'retiring'].includes(item.state)).length > 3)
      ctx.addIssue({ code: 'custom', message: 'Backend limit exceeded' });
  });
export type GenerationInventory = z.infer<typeof inventorySchema>;
const origin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/';
}, 'Expected HTTPS origin');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseDescriptorSchema = z.object({
  schemaVersion: z.literal(1), releaseVersion: releaseVersionSchema, mode: z.enum(['new', 'reuse']),
  backendGeneration: generationSchema, firstRelease: releaseVersionSchema,
  previous: z.object({ releaseVersion: releaseVersionSchema, backendGeneration: generationSchema }).strict().nullable(),
  backend: z.object({ projectId, databaseOrigin: origin }).strict(),
  control: z.object({ projectId, origin }).strict(),
  contract: z.object({ rulesPath: z.string().min(1), rulesSha256: hash,
    schemaPath: z.string().min(1), schemaSha256: hash }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.backend.projectId === value.control.projectId ||
      new URL(value.control.origin).hostname !== `${value.control.projectId}.web.app` ||
      new URL(value.backend.databaseOrigin).hostname !== `${value.backend.projectId}-default-rtdb.europe-west1.firebasedatabase.app` ||
      compareVersions(value.firstRelease, value.releaseVersion) > 0 ||
      (value.mode === 'new' && value.firstRelease !== value.releaseVersion) ||
      (value.previous === null ? value.mode !== 'new' :
        compareVersions(value.releaseVersion, value.previous.releaseVersion) <= 0 ||
        (value.mode === 'new' && value.backendGeneration === value.previous.backendGeneration) ||
        (value.mode === 'reuse' && value.backendGeneration !== value.previous.backendGeneration)))
    ctx.addIssue({ code: 'custom', message: 'Contradictory release mapping' });
});
export type ReleaseDescriptor = z.infer<typeof releaseDescriptorSchema>;
