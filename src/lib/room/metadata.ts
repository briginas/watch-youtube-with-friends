import { z } from 'zod';
import { generationSchema, releaseVersionSchema } from '../backend-generations';
import { backendGeneration, releaseVersion } from '../firebase/config';

export const roomMetadataSchema = z.object({
  name: z.string().min(1).max(200).refine(value => !!value.trim()),
  createdWithVersion: releaseVersionSchema,
  backendGeneration: generationSchema.refine(value => value === backendGeneration),
}).strict();
export type RoomMetadata = z.infer<typeof roomMetadataSchema>;
export function createRoomMetadata(): RoomMetadata {
  const digits = Math.floor(Math.random() * 10_000).toString().padStart(4, '0');
  const name = `🎬 ${digits}`;
  return roomMetadataSchema.parse({ name, createdWithVersion: releaseVersion, backendGeneration });
}
