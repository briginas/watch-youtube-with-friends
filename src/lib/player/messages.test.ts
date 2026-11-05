import { expect, it } from 'vitest';
import { isPlayerControlSender, isPlayerEventSender, playerControlSchema, playerEventSchema } from './messages';

// Deterministic synthetic UUID; no live adapter or session is represented.
const adapter = { adapterToken: '11111111-1111-4111-8111-111111111111', videoRevision: 0 };
const target = '2d945750-2d07-42cc-9439-12ba9824014c';
it('команды принимает только от собственного адресованного session.html', () => {
  const sender = { id: 'extension', url: `chrome-extension://extension/session.html#${target}` };
  expect(isPlayerControlSender(sender, 'extension', target)).toBe(true);
  expect(isPlayerControlSender({ ...sender, id: 'other' }, 'extension', target)).toBe(false);
  expect(isPlayerControlSender({ ...sender, url: sender.url + '0' }, 'extension', target)).toBe(false);
  expect(isPlayerControlSender({ ...sender, url: 'https://www.youtube.com/' }, 'extension', target)).toBe(false);
});
it('bridge пропускает только общие поля и строгие адресованные сообщения', () => {
  const playback = { videoId: 'aqz-KE-bpKQ', positionSeconds: 10, playbackRate: 1, isPlaying: false };
  expect(playerControlSchema.safeParse({ type: 'room-player-apply', target, ...adapter, playback }).success).toBe(true);
  for (const extra of [{ volume: 0.5 }, { revision: 1 }, { key: 'secret' }]) {
    expect(playerControlSchema.safeParse({ type: 'room-player-apply', target, ...adapter, playback: { ...playback, ...extra } }).success).toBe(false);
  }
  expect(playerEventSchema.safeParse({ type: 'room-player-status', target, status: 'ready', key: 'secret' }).success).toBe(false);
  const intent = { kind: 'seek', sample: { positionSeconds: 15, playbackRate: 1, isPlaying: false },
    actionAt: 1000, sampledAt: 1120 };
  expect(playerEventSchema.safeParse({ type: 'room-player-intent', target, ...adapter, videoId: playback.videoId, intent }).success).toBe(true);
  for (const patch of [{ actionAt: -1 }, { sampledAt: 999 }, { sampledAt: Infinity }, { key: 'secret' }]) {
    expect(playerEventSchema.safeParse({ type: 'room-player-intent', target, ...adapter, videoId: playback.videoId, intent: { ...intent, ...patch } }).success).toBe(false);
  }
  expect(playerEventSchema.safeParse({ type: 'room-player-interaction', target, ...adapter, active: true }).success).toBe(true);
  expect(playerEventSchema.safeParse({ type: 'room-player-interaction', target, ...adapter, active: 'true' }).success).toBe(false);
});
it('события принимаются только из верхнего content frame своей вкладки YouTube', () => {
  const sender = { id: 'extension', frameId: 0, tab: { id: 7 }, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' };
  expect(isPlayerEventSender(sender, 'extension', 7)).toBe(true);
  for (const change of [{ id: 'other' }, { frameId: 1 }, { tab: { id: 8 } }, { url: 'https://www.youtube.com.attacker.test/watch' }, { url: 'http://youtube.com/' }]) {
    expect(isPlayerEventSender({ ...sender, ...change }, 'extension', 7)).toBe(false);
  }
});
