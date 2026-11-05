import { z } from 'zod';
import { videoIdSchema } from '../youtube-url';

// Только общие поля плеера; личные настройки и серверные поля здесь запрещены.
export const initialPlaybackSchema = z.object({
  videoId: videoIdSchema,
  positionSeconds: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  playbackRate: z.number().gt(0).max(16),
  isPlaying: z.boolean(),
}).strict();
export type InitialPlayback = z.infer<typeof initialPlaybackSchema>;

export const timestampSchema = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
export const playbackTimingSchema = z.object({
  actionAt: timestampSchema,
  sampledAt: timestampSchema,
});
export type PlaybackTiming = z.infer<typeof playbackTimingSchema>;

// Состояние после разрешения serverTimestamp(), а не объект для записи в RTDB.
export const playbackSchema = initialPlaybackSchema.extend({
  kind: z.enum(['playback', 'switch-video']),
  videoRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: timestampSchema,
  ...playbackTimingSchema.shape,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  actorUid: z.string().min(1),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).refine(state => state.videoRevision <= state.revision
  && (state.kind !== 'switch-video' || state.videoRevision === state.revision),
{ message: 'Invalid video generation' }).refine(state => state.sampledAt >= state.actionAt,
{ message: 'Playback timing must be a complete ordered pair' });
export type Playback = z.infer<typeof playbackSchema>;

const positionContextSchema = z.object({
  nowMs: z.number().finite(),
  serverTimeOffsetMs: z.number().finite(),
  durationSeconds: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type PositionContext = z.infer<typeof positionContextSchema>;

/** Чистый расчёт: часы клиента и RTDB offset заданы в мс, позиция — в секундах. */
export function targetPositionSeconds(playback: Playback, context: PositionContext): number {
  const state = playbackSchema.parse(playback);
  const { nowMs, serverTimeOffsetMs, durationSeconds } = positionContextSchema.parse(context);
  // Оценка времени сервера может оказаться раньше метки позиции: назад не экстраполируем.
  const elapsedSeconds = Math.max(0, (nowMs + serverTimeOffsetMs - state.sampledAt) / 1000);
  const position = state.positionSeconds + (state.isPlaying ? elapsedSeconds * state.playbackRate : 0);
  return Math.min(durationSeconds ?? Number.MAX_SAFE_INTEGER, position);
}
