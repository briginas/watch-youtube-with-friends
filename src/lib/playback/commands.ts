import { z } from 'zod';
import { initialPlaybackSchema, playbackSchema, playbackTimingSchema, type PlaybackTiming, type InitialPlayback, type Playback } from './model';

const commandFields = initialPlaybackSchema.extend({
  baseRevision: playbackSchema.shape.revision,
  commandId: playbackSchema.shape.commandId,
  ...playbackTimingSchema.shape,
});
export const playbackCommandSchema = z.discriminatedUnion('kind', [
  commandFields.extend({ kind: z.literal('playback'), videoRevision: playbackSchema.shape.videoRevision }),
  commandFields.extend({ kind: z.literal('switch-video') }),
]).refine(command => command.sampledAt >= command.actionAt, { message: 'Sample precedes action' });
export type PlaybackCommand = z.infer<typeof playbackCommandSchema>;
export type CommandRejection = 'unavailable' | 'stale' | 'different-video' | 'command-id-conflict'
  | 'revision-exhausted' | 'offline' | 'inactive' | 'busy' | 'different-generation' | 'same-video';
export type CommandResult =
  | { status: 'committed' | 'duplicate'; playback: Playback }
  | { status: 'rejected'; reason: CommandRejection; playback: Playback | null };
type CommandDecision = Extract<CommandResult, { status: 'rejected' }>
  | { status: 'duplicate'; playback: Playback }
  | { status: 'write'; playback: Omit<Playback, 'updatedAt'> };

/** Создаётся один раз на действие; при повторной доставке сохраняем id и базовую версию. */
export function createPlaybackCommand(
  playback: InitialPlayback, baseRevision: number,
  timing: PlaybackTiming = { actionAt: Date.now(), sampledAt: Date.now() },
  videoRevision = 0,
): PlaybackCommand {
  return playbackCommandSchema.parse({ ...playback, ...timing, baseRevision, videoRevision,
    kind: 'playback', commandId: crypto.randomUUID() });
}

export function createVideoSwitchCommand(playback: InitialPlayback, baseRevision: number, timing: PlaybackTiming): PlaybackCommand {
  return playbackCommandSchema.parse({ ...playback, ...timing, baseRevision,
    kind: 'switch-video', commandId: crypto.randomUUID() });
}

/** Повторяемый callback транзакции не меняет команду и не повышает её базовую версию. */
export function preparePlaybackCommand(value: unknown, input: PlaybackCommand, actorUid: string): CommandDecision {
  const command = playbackCommandSchema.parse(input);
  playbackSchema.shape.actorUid.parse(actorUid);
  const parsed = playbackSchema.safeParse(value);
  if (!parsed.success) return { status: 'rejected', reason: 'unavailable', playback: null };
  const current = parsed.data;
  const reject = (reason: CommandRejection): CommandDecision => ({ status: 'rejected', reason, playback: current });

  if (current.commandId === command.commandId) {
    const sameCommand = current.actorUid === actorUid && current.revision > command.baseRevision
      && current.kind === command.kind
      && (command.kind === 'switch-video' || current.videoRevision === command.videoRevision)
      && current.videoId === command.videoId && current.positionSeconds === command.positionSeconds
      && current.playbackRate === command.playbackRate && current.isPlaying === command.isPlaying
      && current.actionAt === command.actionAt && current.sampledAt === command.sampledAt;
    return sameCommand ? { status: 'duplicate', playback: current } : reject('command-id-conflict');
  }
  if (command.kind === 'playback') {
    if (current.videoId !== command.videoId) return reject('different-video');
    if (current.videoRevision !== command.videoRevision) return reject('different-generation');
  } else if (current.videoId === command.videoId) return reject('same-video');
  if (command.baseRevision > current.revision || command.actionAt <= current.actionAt) return reject('stale');
  if (current.revision === Number.MAX_SAFE_INTEGER) return reject('revision-exhausted');

  const { baseRevision, ...sample } = command;
  return { status: 'write', playback: { ...sample, revision: current.revision + 1, actorUid,
    videoRevision: command.kind === 'switch-video' ? current.revision + 1 : command.videoRevision } };
}
