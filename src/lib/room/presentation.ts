import { z } from 'zod';
import { roomMetadataSchema } from './metadata';

export const presentationSchema = z.object({
  type: z.literal('room-presentation'), target: z.string().uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  visible: z.boolean(), name: roomMetadataSchema.shape.name.nullable(),
  width: z.number().int().min(1).max(640), height: z.number().int().min(1).max(4096),
  overlayHeight: z.number().int().min(0).max(4096).optional(),
}).strict();
export type Presentation = z.infer<typeof presentationSchema>;

/** Отбрасывает отложенные resize/render, включая обновления до выхода. */
export function presentationGate() {
  let sequence = -1;
  return (next: Presentation) => {
    if (next.sequence <= sequence) return false;
    sequence = next.sequence;
    return true;
  };
}
