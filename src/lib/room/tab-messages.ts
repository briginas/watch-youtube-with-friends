import { z } from 'zod';
import { roomKeySchema } from './key';
import { videoIdSchema } from '../youtube-url';
import { roomMetadataSchema } from './metadata';
import { catalogRoomSchema } from './catalog';
import { routeSchema, viewSchema } from './view';
import { playbackSchema } from '../playback/model';
import { ownGenerationSchema } from './generation';

const address = { target: z.string().uuid(), backendGeneration: ownGenerationSchema };
const room = { key: roomKeySchema, videoId: videoIdSchema, name: roomMetadataSchema.shape.name, backendGeneration: ownGenerationSchema };
export const tabRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room-tab-route'), ...address, route: routeSchema }).strict(),
  z.object({ type: z.literal('room-tab-view'), ...address, playback: playbackSchema, route: routeSchema,
    ownCommand: z.boolean(), force: z.boolean() }).strict(),
  z.object({ type: z.literal('room-tab-switch-pending'), ...address,
    pending: viewSchema.shape.pendingSwitch.unwrap().nullable() }).strict(),
  z.object({ type: z.literal('room-tab-open'), ...address, ...room, operation: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('room-tab-activate'), ...address, key: roomKeySchema, operation: z.string().uuid() }).strict(),
  z.object({ type: z.literal('room-tab-ready'), ...address }).strict(),
  z.object({ type: z.literal('room-tab-bind'), ...address, ...room }).strict(),
  z.object({ type: z.literal('room-tab-release'), ...address }).strict(),
  z.object({ type: z.literal('room-tab-attach'), ...address }).strict(),
  z.object({ type: z.literal('room-tab-restore'), backendGeneration: ownGenerationSchema }).strict(),
  z.object({ type: z.literal('room-tab-catalog-status'), ...address }).strict(),
  z.object({ type: z.literal('room-tab-catalog-retry'), ...address }).strict(),
]);
export const tabBindingsSchema = z.record(z.string(), z.union([
  z.object({ ...room, view: viewSchema, target: z.string().uuid().optional(), catalogPending: catalogRoomSchema.optional() }).strict(),
  z.object({ ...address }).strict(),
]));

export function isExtensionFrameSender(
  sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } },
  extensionId: string, page: 'invitation' | 'session', target: string,
) {
  return sender.id === extensionId && typeof sender.tab?.id === 'number'
    && typeof sender.frameId === 'number' && sender.frameId > 0
    && sender.url === `chrome-extension://${extensionId}/${page}.html#${target}`;
}

