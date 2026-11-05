import { z } from 'zod';
import { initialPlaybackSchema, playbackTimingSchema, playbackSchema } from '../playback/model';

const address = { target: z.string().uuid() };
export const adapterAddress = { adapterToken: z.string().uuid(), videoRevision: playbackSchema.shape.videoRevision };
const sampleSchema = initialPlaybackSchema.omit({ videoId: true });
export const applyResultSchema = z.enum(['applied', 'blocked', 'interrupted', 'replaced', 'timeout', 'disposed']);
export const playerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room-player-apply'), ...address, ...adapterAddress, playback: initialPlaybackSchema }).strict(),
  z.object({ type: z.literal('room-player-stop'), ...address, adapterToken: z.string().uuid() }).strict(),
]);
export const playerContextRequestSchema = z.object({ type: z.literal('room-player-context'), ...address }).strict();
export const playerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room-player-intent'), ...address, ...adapterAddress,
    videoId: initialPlaybackSchema.shape.videoId,
    intent: z.object({ kind: z.enum(['play', 'pause', 'seek', 'rate']), sample: sampleSchema,
      ...playbackTimingSchema.shape,
    }).strict().refine(intent => intent.sampledAt >= intent.actionAt),
  }).strict(),
  z.object({ type: z.literal('room-player-interaction'), ...address, ...adapterAddress, active: z.boolean() }).strict(),
  z.object({ type: z.literal('room-player-status'), ...address, ...adapterAddress,
    status: z.enum(['ready', 'missing', 'loading', 'buffering', 'ad', 'unavailable', 'unsupported', 'different-video', 'autoplay-blocked']),
    localSeek: z.boolean().default(false),
  }).strict(),
]);

// tabs.sendMessage из extension iframe не содержит sender.tab/frameId.
// Проверяем extension origin и точный адрес session, назначенный этим content script.
export function isPlayerControlSender(sender: { id?: string; url?: string }, extensionId: string, target: string) {
  return sender.id === extensionId && sender.url === `chrome-extension://${extensionId}/session.html#${target}`;
}

export function isPlayerEventSender(
  sender: { id?: string; frameId?: number; tab?: { id?: number }; url?: string },
  extensionId: string, tabId: number,
) {
  if (sender.id !== extensionId || sender.frameId !== 0 || sender.tab?.id !== tabId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && ['www.youtube.com', 'youtube.com'].includes(url.hostname);
  } catch { return false; }
}
