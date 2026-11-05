import { describe, expect, it } from 'vitest';
import { createPlaybackCommand, createVideoSwitchCommand, playbackCommandSchema, preparePlaybackCommand } from './commands';
import { type Playback } from './model';

const current: Playback = { kind: 'playback', videoRevision: 0,
  videoId: 'aqz-KE-bpKQ', positionSeconds: 12, playbackRate: 1, isPlaying: false,
  revision: 7, commandId: 'previous', actorUid: 'first', actionAt: 100_000, sampledAt: 100_000, updatedAt: 100_000,
};
const sample = { videoId: current.videoId, positionSeconds: 42.5, playbackRate: 1.5, isPlaying: true };
const command = { ...sample, kind: 'playback' as const, videoRevision: 0, baseRevision: 7, commandId: 'next', actionAt: 101_000, sampledAt: 101_120 };

describe('команды playback', () => {
  it('создаёт отдельный id для каждого действия и проверяет поля', () => {
    const first = createPlaybackCommand(sample, 7);
    expect(first).toMatchObject({ ...sample, baseRevision: 7 });
    expect(first.commandId).not.toBe(createPlaybackCommand(sample, 7).commandId);
    for (const patch of [{ baseRevision: -1 }, { baseRevision: 0.5 }, { baseRevision: Infinity },
      { baseRevision: Number.MAX_SAFE_INTEGER + 1 }, { commandId: '' }, { commandId: 'bad/id' },
      { actionAt: -1 }, { actionAt: Infinity }, { sampledAt: 100_000 }, { sampledAt: NaN },
      { actorUid: 'spoof' }, { updatedAt: 1 }, { revision: 8 }, { volume: 0.2 }]) {
      expect(playbackCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
    }
  });

  it('готовит ровно одну следующую версию от имени текущего участника', () => {
    const decision = preparePlaybackCommand(Object.freeze({ ...current }), Object.freeze({ ...command }), 'second');
    expect(decision).toEqual({ status: 'write', playback: {
      ...sample, kind: 'playback' as const, videoRevision: 0, revision: 8, actorUid: 'second', commandId: 'next', actionAt: 101_000, sampledAt: 101_120,
    } });
    expect(command.baseRevision).toBe(7);
    expect(current.revision).toBe(7);
  });

  it('при повторном callback с новой версией отклоняет прежнюю команду', () => {
    expect(preparePlaybackCommand(current, command, 'second').status).toBe('write');
    const winner = { ...current, revision: 8, commandId: 'winner', positionSeconds: 100, actionAt: 102_000, sampledAt: 102_000 };
    expect(preparePlaybackCommand(winner, command, 'second')).toEqual({
      status: 'rejected', reason: 'stale', playback: winner,
    });
  });

  it('повтор принятой команды не создаёт ещё одну версию', () => {
    const accepted = { ...sample, kind: 'playback' as const, videoRevision: 0, revision: 8, actorUid: 'second', commandId: 'next', updatedAt: 102_000,
      actionAt: command.actionAt, sampledAt: command.sampledAt };
    expect(preparePlaybackCommand(accepted, command, 'second')).toEqual({ status: 'duplicate', playback: accepted });
    for (const patch of [{ baseRevision: 8 }, { positionSeconds: 100 }, { videoId: 'dQw4w9WgXcQ' },
      { actionAt: 101_001 }, { sampledAt: 101_121 }]) {
      expect(preparePlaybackCommand(accepted, { ...command, ...patch }, 'second')).toMatchObject({
        status: 'rejected', reason: 'command-id-conflict',
      });
    }
    expect(preparePlaybackCommand(accepted, command, 'first')).toMatchObject({
      status: 'rejected', reason: 'command-id-conflict',
    });
    expect(preparePlaybackCommand({ ...accepted, revision: 9, commandId: 'newer' }, command, 'second')).toMatchObject({
      status: 'rejected', reason: 'stale',
    });
  });

  it.each([false, true])('при перестановке доставки newerFirst=%s побеждает более позднее действие из той же базы', newerFirst => {
    const earlier = { ...command, commandId: 'earlier', actionAt: 101_000, sampledAt: 101_120 };
    const later = { ...command, commandId: 'later', actionAt: 102_000, sampledAt: 102_120, positionSeconds: 300 };
    let state = current;
    for (const input of newerFirst ? [later, earlier] : [earlier, later]) {
      const decision = preparePlaybackCommand(state, input, 'second');
      if (decision.status === 'write') state = { ...decision.playback, updatedAt: 104_000 };
      else expect(decision).toMatchObject({ status: 'rejected', reason: 'stale' });
    }
    expect(state).toMatchObject({ commandId: 'later', positionSeconds: 300, actionAt: 102_000, sampledAt: 102_120 });
    expect(preparePlaybackCommand(state, later, 'second').status).toBe('duplicate');
  });

  it('при одинаковом времени не заменяет первое принятое действие; будущую базу отклоняет', () => {
    const state = { ...current, actionAt: command.actionAt, sampledAt: command.sampledAt };
    expect(preparePlaybackCommand(state, command, 'second')).toMatchObject({ status: 'rejected', reason: 'stale' });
    expect(preparePlaybackCommand(current, { ...command, baseRevision: 8 }, 'second'))
      .toMatchObject({ status: 'rejected', reason: 'stale' });
  });

  it('не создаёт отсутствующее состояние, не меняет видео и не переполняет revision', () => {
    for (const value of [null, {}, { ...current, updatedAt: { '.sv': 'timestamp' } }]) {
      expect(preparePlaybackCommand(value, command, 'second')).toEqual({
        status: 'rejected', reason: 'unavailable', playback: null,
      });
    }
    expect(preparePlaybackCommand(current, { ...command, videoId: 'dQw4w9WgXcQ' }, 'second')).toMatchObject({
      status: 'rejected', reason: 'different-video',
    });
    expect(preparePlaybackCommand({ ...current, revision: Number.MAX_SAFE_INTEGER }, {
      ...command, baseRevision: Number.MAX_SAFE_INTEGER,
    }, 'second')).toMatchObject({ status: 'rejected', reason: 'revision-exhausted' });
    expect(() => preparePlaybackCommand(current, command, '')).toThrow();
  });
});

it.each([false, true])('смены видео согласуются по времени, reverse=%s', reverse => {
  const earlier = createVideoSwitchCommand({ ...sample, videoId: 'dQw4w9WgXcQ' }, 7, { actionAt: 101000, sampledAt: 101100 });
  const later = createVideoSwitchCommand({ ...sample, videoId: 'M7lc1UVf-VE' }, 7, { actionAt: 102000, sampledAt: 102100 });
  let state = current;
  for (const command of reverse ? [later, earlier] : [earlier, later]) {
    const result = preparePlaybackCommand(state, command, 'second');
    if (result.status === 'write') state = { ...result.playback, updatedAt: 103000 };
    else expect(result).toMatchObject({ status: 'rejected', reason: 'stale' });
  }
  expect(state).toMatchObject({ kind: 'switch-video', videoId: later.videoId, videoRevision: state.revision,
    positionSeconds: sample.positionSeconds, actionAt: later.actionAt, sampledAt: later.sampledAt });
  expect(preparePlaybackCommand(state, later, 'second').status).toBe('duplicate');
});

it('защищает A → B → A от поздней команды первого просмотра A', () => {
  let state = current;
  for (const [index, videoId] of ['dQw4w9WgXcQ', current.videoId].entries()) {
    const result = preparePlaybackCommand(state, createVideoSwitchCommand({ ...sample, videoId }, state.revision,
      { actionAt: 101000 + index * 1000, sampledAt: 101100 + index * 1000 }), 'second');
    expect(result.status).toBe('write');
    if (result.status === 'write') state = { ...result.playback, updatedAt: 104000 };
  }
  expect(preparePlaybackCommand(state, createPlaybackCommand(sample, state.revision,
    { actionAt: 110000, sampledAt: 110100 }, 0), 'first')).toMatchObject({ status: 'rejected', reason: 'different-generation' });
  expect(preparePlaybackCommand(state, createVideoSwitchCommand(sample, state.revision,
    { actionAt: 110000, sampledAt: 110100 }), 'first')).toMatchObject({ status: 'rejected', reason: 'same-video' });
});
