import { z } from 'zod';
import { roomKeySchema } from './key';
import { initialPlaybackSchema } from './creation';
import { roomMetadataSchema } from './metadata';
import { ownGenerationSchema } from './generation';
import type { TransportState } from './transport';

export type PopupSessionState = TransportState & { roomName: string | null; roomInvitation: string | null };

export const playerSnapshotRequestSchema = z.object({
  type: z.literal('room-player-snapshot'), target: z.string().uuid(),
}).strict();

export const sessionRequestSchema = z.discriminatedUnion('action', [
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('status') }).strict(),
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('retry') }).strict(),
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('stop') }).strict(),
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('watch'), key: roomKeySchema }).strict(),
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('unwatch') }).strict(),
  z.object({ type: z.literal('room-session'), backendGeneration: ownGenerationSchema, target: z.string().uuid(), action: z.literal('create'), playback: initialPlaybackSchema, metadata: roomMetadataSchema }).strict(),
]);

export function isPopupSender(sender: { id?: string; url?: string }, extensionId: string) {
  return sender.id === extensionId && sender.url === `chrome-extension://${extensionId}/popup.html`;
}
