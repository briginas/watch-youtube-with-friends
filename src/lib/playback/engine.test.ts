import { describe, expect, it, vi } from 'vitest';
import { createSyncEngine } from './engine';
import type { Playback } from './model';
import type { CommandResult, PlaybackCommand } from './commands';

const initial: Playback = {
  videoId: 'aqz-KE-bpKQ', positionSeconds: 10, playbackRate: 1.5, isPlaying: true,
  revision: 0, kind: 'playback' as const, videoRevision: 0, actionAt: 1000, sampledAt: 1000, updatedAt: 1000, actorUid: 'other', commandId: 'initial',
};
const intent = { kind: 'pause' as const, sample: { positionSeconds: 14, playbackRate: 1.5, isPlaying: false },
  actionAt: 2000, sampledAt: 2120 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup(sendCommand = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>()) {
  const apply = vi.fn().mockResolvedValue('applied');
  const stop = vi.fn();
  const onError = vi.fn();
  const engine = createSyncEngine({ apply, stop, sendCommand, now: () => 3000, onError });
  const update = (playback: unknown = initial, connected = true) => engine.update({ playback, connected, serverTimeOffset: 1000 });
  return { engine, apply, stop, onError, update, sendCommand };
}

describe('sync engine', () => {
  it('применяет начальную позицию с серверным offset, затем только новые revision', async () => {
    const { update, apply } = setup();
    update();
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, { positionSeconds: 14.5, playbackRate: 1.5, isPlaying: true });
    update();
    update({ ...initial, revision: 1, commandId: 'pause', positionSeconds: 25, isPlaying: false });
    update(initial);
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, { positionSeconds: 25, playbackRate: 1.5, isPlaying: false });
  });

  it('собственное подтверждение не перематывает локальный плеер и не отправляет команд повторно', async () => {
    let complete!: (result: CommandResult) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>(() => new Promise(resolve => { complete = resolve; }));
    const { engine, update, apply } = setup(send);
    update();
    const pending = engine.intent(intent);
    const command = send.mock.calls[0]![0];
    expect(command).toMatchObject({ ...intent.sample, videoId: initial.videoId, baseRevision: 0 });
    const ack = { ...initial, ...intent.sample, revision: 1, commandId: command.commandId };
    update(ack); // onValue может прийти до Promise транзакции.
    complete({ status: 'committed', playback: ack });
    await pending;
    expect(apply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    update({ ...ack, revision: 2, commandId: 'remote' });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('при проигранном конфликте применяет победителя, поздний ответ не откатывает новую revision', async () => {
    let complete!: (result: CommandResult) => void;
    const { engine, update, apply, sendCommand } = setup(vi.fn(() => new Promise(resolve => { complete = resolve; })));
    update();
    const pending = engine.intent(intent);
    update({ ...initial, revision: 2, commandId: 'newer', positionSeconds: 40, isPlaying: false });
    complete({ status: 'rejected', reason: 'stale', playback: { ...initial, revision: 1, commandId: 'winner' } });
    await pending;
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 40 }));
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('выход отсекает поздние результаты и останавливает адаптер; новая комната начинает с revision 0', async () => {
    let complete!: (result: CommandResult) => void;
    const { engine, update, apply, stop } = setup(vi.fn(() => new Promise(resolve => { complete = resolve; })));
    update();
    const pending = engine.intent(intent);
    update(null);
    complete({ status: 'committed', playback: { ...initial, revision: 1 } });
    await pending;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    update({ ...initial, positionSeconds: 0 });
    expect(apply).toHaveBeenCalledTimes(2);
    engine.dispose();
    update();
    await engine.intent(intent);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('offline и невыбранная комната не создают команды; reconnect применяет сохранённую версию', async () => {
    const { engine, update, apply, sendCommand } = setup();
    await engine.intent(intent);
    update(initial, false);
    await engine.intent(intent);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    update();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('отказ записи восстанавливает общую версию и сообщает ошибку', async () => {
    const { engine, update, apply, onError } = setup(vi.fn().mockRejectedValue(new Error('denied')));
    update();
    await engine.intent(intent);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('Не удалось отправить'));
  });

  it.each(['committed', 'error'] as const)('reconnect отсекает поздний %s и сразу допускает новый ввод', async outcome => {
    let complete!: (result: CommandResult) => void;
    let fail!: (error: Error) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
    const { engine, update, apply, stop, onError } = setup(send);
    update();
    const pending = engine.intent(intent);
    const old = send.mock.calls[0]![0];
    update(initial, false);
    expect(stop).toHaveBeenCalledTimes(1);
    await engine.intent(intent);
    expect(send).toHaveBeenCalledTimes(1);
    const latest = { ...initial, revision: 2, commandId: 'remote-latest', positionSeconds: 50, isPlaying: false };
    update(latest);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 50 }));
    if (outcome === 'error') fail(new Error('disconnect'));
    else complete({ status: 'committed', playback: { ...initial, revision: 1, commandId: old.commandId } });
    await pending;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalledWith(expect.any(String));
    send.mockImplementationOnce(async command => ({ status: 'committed', playback: {
      ...latest, ...intent.sample, revision: 3, commandId: command.commandId,
    } }));
    await engine.intent(intent);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].baseRevision).toBe(2);
  });

  it('сохраняет только последнее действие во время отправки без промежуточного отката', async () => {
    let complete!: (result: CommandResult) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>(() => new Promise(resolve => { complete = resolve; }));
    const { engine, update, apply } = setup(send);
    update();
    const pending = engine.intent(intent);
    await engine.intent({ ...intent, actionAt: 2200, sampledAt: 2320, sample: { ...intent.sample, positionSeconds: 20 } });
    await engine.intent({ ...intent, actionAt: 2400, sampledAt: 2520, sample: { ...intent.sample, positionSeconds: 30 } });
    complete({ status: 'committed', playback: { ...initial, ...intent.sample, revision: 1, commandId: send.mock.calls[0]![0].commandId } });
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    const next = send.mock.calls[1]![0];
    expect(next).toMatchObject({ positionSeconds: 30, actionAt: 3400, sampledAt: 3520 });
    expect(apply).toHaveBeenCalledTimes(1);
    complete({ status: 'committed', playback: { ...initial, ...next, revision: 2, updatedAt: 4000 } });
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('после готовности повторяет blocked из последней версии без исходящих команд', async () => {
    const { engine, update, apply, sendCommand } = setup();
    apply.mockResolvedValue('blocked');
    update();
    await flush();
    engine.playerStatus('ready');
    expect(apply).toHaveBeenCalledTimes(2);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('не прерывает жест входящим состоянием; intent завершает защиту без применения старой позиции', async () => {
    const send = vi.fn().mockImplementation(async (command: PlaybackCommand) => ({ status: 'committed', playback: {
      ...initial, ...command, revision: 2, updatedAt: 4000,
    } }));
    const { engine, update, apply } = setup(send);
    update();
    await flush();
    engine.playerInteraction(true);
    update({ ...initial, revision: 1, actionAt: 2500, sampledAt: 2500, positionSeconds: 50, isPlaying: false });
    expect(apply).toHaveBeenCalledTimes(1);
    await engine.intent(intent); // actionAt 2000 + server offset 1000 > remote 2500
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ actionAt: 3000, sampledAt: 3120, baseRevision: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    update({ ...initial, revision: 3, actionAt: 5000, sampledAt: 5000, positionSeconds: 99, isPlaying: false });
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 99 }));
  });

  it('отмена жеста применяет последнюю полученную версию, а не позицию начала жеста', async () => {
    const { engine, update, apply } = setup();
    update();
    await flush();
    engine.playerInteraction(true);
    update({ ...initial, revision: 1, actionAt: 2500, sampledAt: 2500, positionSeconds: 50, isPlaying: false });
    engine.playerInteraction(false);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 50 }));
  });

  it('более позднее удалённое действие отменяет ожидающее локальное, поздний ack не откатывает его', async () => {
    let complete!: (result: CommandResult) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>(() => new Promise(resolve => { complete = resolve; }));
    const { engine, update, apply } = setup(send);
    update();
    await flush();
    const pending = engine.intent(intent);
    const first = send.mock.calls[0]![0];
    await engine.intent({ ...intent, actionAt: 2400, sampledAt: 2520, sample: { ...intent.sample, positionSeconds: 30 } });
    update({ ...initial, revision: 2, actionAt: 4000, sampledAt: 4000, positionSeconds: 50, isPlaying: false });
    complete({ status: 'committed', playback: { ...initial, ...first, revision: 1, updatedAt: 3500 } });
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 50 }));
  });

  it.each(['disconnect', 'ad', 'unavailable', 'leave'] as const)('%s отменяет следующее неотправленное действие', async restriction => {
    let complete!: (result: CommandResult) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>(() => new Promise(resolve => { complete = resolve; }));
    const { engine, update } = setup(send);
    update();
    const pending = engine.intent(intent);
    const first = send.mock.calls[0]![0];
    await engine.intent({ ...intent, actionAt: 2400, sampledAt: 2520 });
    if (restriction === 'disconnect') update(initial, false);
    else if (restriction === 'leave') update(null);
    else engine.playerStatus(restriction);
    complete({ status: 'committed', playback: { ...initial, ...first, revision: 1, updatedAt: 3500 } });
    await pending;
    update({ ...initial, revision: 2, positionSeconds: 50, isPlaying: false });
    engine.playerStatus('ready');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('старое локальное действие после более нового удалённого не отправляется', async () => {
    const { engine, update, sendCommand, apply } = setup();
    update({ ...initial, actionAt: 4000, sampledAt: 4000 });
    await engine.intent(intent); // corrected actionAt 3000
    expect(sendCommand).not.toHaveBeenCalled();
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 10 }));
  });

  it('локальный seek и его buffering не вызывают повтор старого apply до выдачи intent', async () => {
    const { engine, update, apply } = setup();
    update();
    await flush();
    engine.playerStatus('buffering', true);
    engine.playerStatus('ready');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each(['ad', 'buffering', 'autoplay-blocked', 'loading', 'unavailable', 'different-video'] as const)(
    '%s не создаёт команд; готовность применяет только последнюю revision с новым временем', async status => {
      let now = 3000;
      const apply = vi.fn().mockResolvedValue('applied');
      const sendCommand = vi.fn();
      const engine = createSyncEngine({ apply, sendCommand, stop() {}, now: () => now });
      const update = (playback: Playback) => engine.update({ playback, connected: true, serverTimeOffset: 1000 });
      update(initial);
      await flush();
      engine.playerStatus(status);
      await engine.intent(intent);
      update({ ...initial, revision: 1, commandId: 'middle', positionSeconds: 20 });
      update({ ...initial, revision: 2, commandId: 'latest', positionSeconds: 40, actionAt: 5000, sampledAt: 5000, updatedAt: 5000 });
      expect(apply).toHaveBeenCalledTimes(1);
      now = 6000;
      engine.playerStatus('ready');
      await flush();
      expect(apply).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenLastCalledWith(initial.videoId, {
        positionSeconds: 43, playbackRate: 1.5, isPlaying: true,
      });
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it('после локального ограничения восстанавливается даже без новых команд комнаты', async () => {
    const { engine, update, apply } = setup();
    update();
    await flush();
    engine.playerStatus('ad');
    engine.playerStatus('ready');
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
    engine.playerStatus('ready');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it.each(['blocked', 'replaced', 'timeout'] as const)('ready до позднего %s не теряет повтор применения', async result => {
    let complete!: (result: string) => void;
    const { engine, update, apply } = setup();
    apply.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    update();
    engine.playerStatus('buffering');
    engine.playerStatus('ready');
    expect(apply).toHaveBeenCalledTimes(1);
    complete(result);
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('успешное применение после собственного buffering не запускает новый seek по кругу', async () => {
    let complete!: (result: string) => void;
    const { engine, update, apply, sendCommand } = setup();
    apply.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    update();
    engine.playerStatus('buffering');
    engine.playerStatus('ready');
    complete('applied');
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(sendCommand).not.toHaveBeenCalled();
    // Независимое ограничение после завершения по-прежнему требует восстановления.
    engine.playerStatus('buffering');
    engine.playerStatus('ready');
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('успех старого apply не теряет новую revision, полученную во время buffering', async () => {
    let complete!: (result: string) => void;
    const { engine, update, apply } = setup();
    apply.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    update();
    engine.playerStatus('buffering');
    update({ ...initial, revision: 1, commandId: 'new', positionSeconds: 40, isPlaying: false });
    engine.playerStatus('ready');
    complete('applied');
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, expect.objectContaining({ positionSeconds: 40, isPlaying: false }));
  });

  it('поздний успешный ответ не отменяет текущее локальное ограничение', async () => {
    let complete!: (result: string) => void;
    const { engine, update, apply } = setup();
    apply.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    update();
    engine.playerStatus('buffering');
    complete('applied');
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    engine.playerStatus('ready');
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('поздний успех apply не отменяет восстановление нового локального seek после ack', async () => {
    let completeApply!: (result: string) => void;
    let completeCommand!: (result: CommandResult) => void;
    const send = vi.fn<(command: PlaybackCommand) => Promise<CommandResult>>(() => new Promise(resolve => { completeCommand = resolve; }));
    const { engine, update, apply } = setup(send);
    apply.mockImplementationOnce(() => new Promise(resolve => { completeApply = resolve; }));
    update();
    engine.playerStatus('buffering', true);
    const pending = engine.intent({ ...intent, kind: 'seek' });
    engine.playerStatus('ready');
    completeApply('applied');
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    completeCommand({ status: 'committed', playback: {
      ...initial, ...intent.sample, revision: 1, commandId: send.mock.calls[0]![0].commandId,
    } });
    await pending;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, intent.sample);
  });

  it('локальный seek во время своей буферизации разрешён; остальные действия блокируются', async () => {
    const { engine, update, sendCommand } = setup(vi.fn().mockResolvedValue({ status: 'rejected' }));
    update();
    await flush();
    engine.playerStatus('buffering', true);
    await engine.intent(intent);
    expect(sendCommand).not.toHaveBeenCalled();
    await engine.intent({ ...intent, kind: 'seek' });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('долгая буферизация от seek восстанавливает состояние после ack, не возвращает старую версию', async () => {
    let complete!: (result: CommandResult) => void;
    const { engine, update, apply, sendCommand } = setup(vi.fn(() => new Promise(resolve => { complete = resolve; })));
    update();
    await flush();
    engine.playerStatus('buffering', true);
    const pending = engine.intent({ ...intent, kind: 'seek' });
    engine.playerStatus('ready');
    expect(apply).toHaveBeenCalledTimes(1);
    complete({ status: 'committed', playback: {
      ...initial, ...intent.sample, revision: 1, commandId: sendCommand.mock.calls[0]![0].commandId,
    } });
    await pending;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(initial.videoId, intent.sample);
  });
});

it('новое поколение отменяет старый жест, очередь и callback даже при A → B → A', async () => {
  let completeApply!: (result: string) => void;
  let completeCommand!: (result: CommandResult) => void;
  const apply = vi.fn().mockResolvedValue('applied')
    .mockImplementationOnce(() => new Promise(resolve => { completeApply = resolve; }));
  const stop = vi.fn();
  const sendCommand = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'stale', playback: null })
    .mockImplementationOnce(() => new Promise(resolve => { completeCommand = resolve; }));
  const engine = createSyncEngine({ apply, stop, sendCommand });
  engine.update({ playback: initial, connected: true, serverTimeOffset: 0 });
  const pending = engine.intent(intent);
  await engine.intent({ ...intent, actionAt: 2200, sampledAt: 2300 });
  engine.playerInteraction(true);
  engine.playerStatus('different-video');
  const switched = { ...initial, kind: 'switch-video', revision: 3, videoRevision: 3, commandId: 'return-A' };
  engine.update({ playback: switched, connected: true, serverTimeOffset: 0 });
  await Promise.resolve();
  expect(stop).toHaveBeenCalled();
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls.at(-1)?.[0]).toBe(initial.videoId);
  completeApply('blocked');
  completeCommand({ status: 'committed', playback: { ...initial, revision: 2, commandId: 'old-ack' } });
  await pending;
  await flush();
  expect(sendCommand).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(2);
  await engine.intent({ ...intent, actionAt: 4000, sampledAt: 4120 });
  expect(sendCommand.mock.calls.at(-1)?.[0]).toMatchObject({ videoRevision: 3, baseRevision: 3 });
  engine.dispose();
});
