import { z } from 'zod';
import { roomKeySchema } from './key';
import { playbackSchema } from '../playback/model';
import { roomMetadataSchema } from './metadata';
import { generationSchema } from '../backend-generations';

export function isInvitationPage(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.origin === base.origin && url.pathname === base.pathname
      && !url.username && !url.password && !url.href.split('#', 1)[0]?.includes('?');
  } catch { return false; }
}

export function invitationKey(value: string, baseUrl: string): string | null {
  return parseInvitation(value, baseUrl)?.key ?? null;
}

export function parseInvitation(value: string, baseUrl: string): { key: string; backendGeneration: string } | null {
  if (!isInvitationPage(value, baseUrl)) return null;
  const params = new URLSearchParams(new URL(value).hash.slice(1));
  if (params.size !== 2 || !params.has('room') || !params.has('generation')) return null;
  const parsed = roomKeySchema.safeParse(params.get('room'));
  const generation = generationSchema.safeParse(params.get('generation'));
  return parsed.success && generation.success ? { key: parsed.data, backendGeneration: generation.data } : null;
}

export const invitationRequestSchema = z.object({
  type: z.literal('room-invitation'), target: z.string().uuid(),
  // null позволяет показать ошибку повреждённой ссылки внутри extension UI.
  key: roomKeySchema.nullable(),
  backendGeneration: generationSchema.nullable(),
}).strict().refine(value => (value.key === null) === (value.backendGeneration === null));

export function isInvitationSender(
  sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } },
  extensionId: string, baseUrl: string,
): boolean {
  return sender.id === extensionId && sender.frameId === 0
    && typeof sender.tab?.id === 'number' && !!sender.url && isInvitationPage(sender.url, baseUrl);
}

export const invitationRoomSchema = z.object({
  metadata: roomMetadataSchema,
  playback: playbackSchema,
});
