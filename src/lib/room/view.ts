import { z } from 'zod';
import { videoIdSchema } from '../youtube-url';
import { playbackSchema, type Playback } from '../playback/model';

export const routeSchema = z.object({
  videoId: videoIdSchema.nullable(), sequence: z.number().int().nonnegative().safe(),
}).strict();
export const viewSchema = z.object({
  mode: z.enum(['following', 'detached']),
  route: routeSchema,
  revision: playbackSchema.shape.revision,
  videoRevision: playbackSchema.shape.videoRevision,
  pendingNavigation: z.object({
    videoId: videoIdSchema, videoRevision: playbackSchema.shape.videoRevision,
    operationToken: z.string().uuid(), source: routeSchema,
  }).strict().optional(),
  pendingSwitch: z.object({ commandId: playbackSchema.shape.commandId, videoId: videoIdSchema }).strict().optional(),
}).strict();
export type RoomView = z.infer<typeof viewSchema>;
export type PlayerRoute = z.infer<typeof routeSchema>;
export function initialView(videoId: string): RoomView {
  return { mode: 'following', route: { videoId, sequence: 0 }, revision: 0, videoRevision: 0 };
}
/** Не включает following от одного совпадения нового серверного videoId. */
export function observeRoute(view: RoomView, route: PlayerRoute, sharedVideoId: string, newDocument = false): RoomView {
  if (!newDocument && route.sequence < view.route.sequence) return view;
  const next = { ...view, route };
  if (view.pendingNavigation?.videoId === route.videoId) {
    next.mode = 'following';
    delete next.pendingNavigation;
  } else if (route.videoId !== view.route.videoId) {
    next.mode = route.videoId === sharedVideoId ? 'following' : 'detached';
    delete next.pendingNavigation;
  }
  return next;
}
export function reconcileView(view: RoomView, playback: Playback, ownCommand: boolean, force = false): RoomView {
  if (playback.revision < view.revision) return view;
  const next = { ...view, revision: playback.revision, videoRevision: playback.videoRevision };
  // Уже начатая загрузка может завершиться после следующей смены. Она остаётся
  // переходом комнаты: новый документ прочитает сервер и продолжит к последней цели.
  const confirmed = ownCommand && view.pendingSwitch?.commandId === playback.commandId;
  if (force || confirmed) next.mode = 'following';
  // После reconnect результат не воспроизводится как новая команда.
  if (view.pendingSwitch && (confirmed || force)) delete next.pendingSwitch;
  return next;
}
