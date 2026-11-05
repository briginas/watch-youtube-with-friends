import { z } from 'zod';
import { roomKeySchema } from './key';
import { catalogRoomSchema } from './catalog';
import { ownGenerationSchema } from './generation';

export const catalogRequestSchema = z.discriminatedUnion('action', [
  z.object({ type: z.literal('room-catalog'), backendGeneration: ownGenerationSchema, action: z.literal('list') }).strict(),
  z.object({ type: z.literal('room-catalog'), backendGeneration: ownGenerationSchema, action: z.literal('remove'), key: roomKeySchema }).strict(),
  z.object({ type: z.literal('room-catalog'), backendGeneration: ownGenerationSchema, action: z.literal('activate'), key: roomKeySchema, operation: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('room-catalog'), backendGeneration: ownGenerationSchema, action: z.literal('open'), room: catalogRoomSchema, operation: z.string().uuid().optional() }).strict(),
]);
