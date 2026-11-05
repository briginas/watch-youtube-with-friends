import { describe, expect, it } from 'vitest';
import { initialPlaybackSchema, playbackSchema, targetPositionSeconds, type Playback } from './model';

const playback: Playback = {
  videoId: 'aqz-KE-bpKQ', positionSeconds: 12.5, playbackRate: 1,
  isPlaying: true, actionAt: 100_000, sampledAt: 100_000, updatedAt: 100_000, revision: 0, kind: 'playback' as const, videoRevision: 0, actorUid: 'uid', commandId: 'command-1',
};

describe('модель playback', () => {
  it('принимает начальную и последующую версии без изменения данных', () => {
    expect(playbackSchema.parse(playback)).toEqual(playback);
    expect(playbackSchema.parse({ ...playback, revision: 42, isPlaying: false }).revision).toBe(42);
    expect(playbackSchema.safeParse({ ...playback, positionSeconds: 0, updatedAt: 0,
      playbackRate: 16, revision: Number.MAX_SAFE_INTEGER, commandId: '_'.repeat(128) }).success).toBe(true);
  });

  it('отклоняет неполные данные и неразрешённый serverTimestamp', () => {
    for (const field of Object.keys(playback)) {
      const incomplete: Record<string, unknown> = { ...playback };
      delete incomplete[field];
      expect(playbackSchema.safeParse(incomplete).success, field).toBe(false);
    }
    for (const value of [null, undefined, [], 'playback', { ...playback, updatedAt: { '.sv': 'timestamp' } }]) {
      expect(playbackSchema.safeParse(value).success).toBe(false);
    }
    // Серверные поля не могут прийти в запросе создания комнаты.
    expect(initialPlaybackSchema.safeParse(playback).success).toBe(false);
  });

  it.each([
    { videoId: 'bad' }, { videoId: 'a'.repeat(12) },
    { positionSeconds: -1 }, { positionSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { positionSeconds: NaN }, { positionSeconds: Infinity },
    { playbackRate: 0 }, { playbackRate: -1 }, { playbackRate: 16.01 },
    { playbackRate: NaN }, { playbackRate: Infinity },
    { isPlaying: 'true' }, { isPlaying: 1 },
    { updatedAt: -1 }, { updatedAt: NaN }, { updatedAt: Infinity },
    { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { revision: -1 }, { revision: 0.5 }, { revision: NaN }, { revision: Infinity },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { actorUid: '' }, { actorUid: null }, { commandId: '' },
    { actionAt: undefined }, { sampledAt: undefined }, { actionAt: -1, sampledAt: 100_000 },
    { actionAt: 100_000, sampledAt: 99_999 }, { actionAt: 100_000, sampledAt: Infinity },
    { commandId: 'a'.repeat(129) }, { commandId: 'path/to/command' },
    { volume: 0.5 }, { quality: 'hd1080' }, { subtitles: 'ru' }, { unknown: true },
  ])('отклоняет некорректные и лишние поля: %j', patch => {
    expect(playbackSchema.safeParse({ ...playback, ...patch }).success).toBe(false);
  });
});

describe('целевая позиция', () => {
  it('считает прошедшее время от считывания позиции, включая задержку записи и offset', () => {
    expect(targetPositionSeconds({ ...playback, actionAt: 90_000, sampledAt: 91_000 }, {
      nowMs: 104_000, serverTimeOffsetMs: 1000,
    })).toBe(26.5);
    expect(targetPositionSeconds({ ...playback, actionAt: 90_000, sampledAt: 91_000, isPlaying: false }, {
      nowMs: 104_000, serverTimeOffsetMs: 1000,
    })).toBe(12.5);
  });
  it.each([0.25, 0.5, 1, 1.5, 2, 16])('учитывает прошедшие секунды и скорость %s', playbackRate => {
    expect(targetPositionSeconds({ ...playback, playbackRate }, {
      nowMs: 102_500, serverTimeOffsetMs: 0,
    })).toBeCloseTo(12.5 + 2.5 * playbackRate);
  });

  it.each([-30_000, 0, 45_000])('получает одну позицию при смещении часов сервера %s мс', offset => {
    // Сервер сейчас показывает 105000 мс независимо от часов клиента.
    expect(targetPositionSeconds(playback, {
      nowMs: 105_000 - offset, serverTimeOffsetMs: offset,
    })).toBe(17.5);
  });

  it('на паузе сохраняет позицию независимо от времени и скорости', () => {
    expect(targetPositionSeconds({ ...playback, isPlaying: false, playbackRate: 2 }, {
      nowMs: 9_000_000, serverTimeOffsetMs: -30_000,
    })).toBe(12.5);
  });

  it.each([99_000, 100_000])('не перематывает назад при времени сервера %s', nowMs => {
    expect(targetPositionSeconds(playback, { nowMs, serverTimeOffsetMs: 0 })).toBe(12.5);
  });

  it('сохраняет нулевую и дробную позицию в момент обновления', () => {
    for (const positionSeconds of [0, 0.125]) {
      expect(targetPositionSeconds({ ...playback, positionSeconds }, {
        nowMs: 100_000, serverTimeOffsetMs: 0,
      })).toBe(positionSeconds);
    }
  });

  it.each([true, false])('ограничивает позицию длительностью ролика при isPlaying=%s', isPlaying => {
    const state = { ...playback, isPlaying };
    const context = { nowMs: 120_000, serverTimeOffsetMs: 0 };
    expect(targetPositionSeconds(state, { ...context, durationSeconds: 10 })).toBe(10);
    expect(targetPositionSeconds(state, { ...context, durationSeconds: 0 })).toBe(0);
    expect(targetPositionSeconds(state, { ...context, durationSeconds: 32.5 })).toBe(isPlaying ? 32.5 : 12.5);
  });

  it('при неизвестной длительности ограничивает результат безопасным диапазоном', () => {
    expect(targetPositionSeconds({ ...playback, positionSeconds: Number.MAX_SAFE_INTEGER }, {
      nowMs: Number.MAX_SAFE_INTEGER, serverTimeOffsetMs: 0,
    })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    { nowMs: NaN }, { nowMs: Infinity }, { serverTimeOffsetMs: NaN }, { serverTimeOffsetMs: -Infinity },
    { durationSeconds: -1 }, { durationSeconds: NaN }, { durationSeconds: Infinity },
  ])('отклоняет некорректные часы или длительность: %j', patch => {
    expect(() => targetPositionSeconds(playback, {
      nowMs: 100_000, serverTimeOffsetMs: 0, ...patch,
    })).toThrow();
  });

  it('проверяет playback на входе и не изменяет исходное состояние', () => {
    const state = Object.freeze({ ...playback });
    expect(targetPositionSeconds(state, { nowMs: 101_000, serverTimeOffsetMs: 0 })).toBe(13.5);
    expect(state).toEqual(playback);
    expect(() => targetPositionSeconds({ ...playback, playbackRate: NaN }, {
      nowMs: 101_000, serverTimeOffsetMs: 0,
    })).toThrow();
  });
});

it('проверяет поколение и вид команды как обязательный контракт', () => {
  for (const patch of [{ videoRevision: -1 }, { videoRevision: 0.5 }, { videoRevision: 1 },
    { kind: 'switch-video', revision: 2, videoRevision: 1 }, { kind: 'other' }]) {
    expect(playbackSchema.safeParse({ ...playback, ...patch }).success).toBe(false);
  }
  expect(playbackSchema.safeParse({ ...playback, kind: 'switch-video', revision: 2, videoRevision: 2 }).success).toBe(true);
});
