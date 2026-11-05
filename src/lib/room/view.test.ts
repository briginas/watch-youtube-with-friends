import { expect, it } from 'vitest';
import { initialView, observeRoute, reconcileView, viewSchema } from './view';
import type { Playback } from '../playback/model';
const a = 'aqz-KE-bpKQ', b = 'dQw4w9WgXcQ';
const next: Playback = { videoId: b, kind: 'switch-video', videoRevision: 1, revision: 1,
  positionSeconds: 12, playbackRate: 1, isPlaying: false, actorUid: 'other', commandId: 'switch',
  updatedAt: 100, actionAt: 100, sampledAt: 100 };
it('локальный уход сохраняется при reload и совпадении новой цели с локальным видео', () => {
  const detached = observeRoute(initialView(a), { videoId: b, sequence: 1 }, a);
  expect(detached.mode).toBe('detached');
  const updated = reconcileView(detached, next, false);
  expect(updated.mode).toBe('detached');
  expect(observeRoute(updated, { videoId: b, sequence: 0 }, b, true).mode).toBe('detached');
  expect(reconcileView(updated, next, false, true).mode).toBe('following');
});
it('ожидаемый переход комнаты и явная навигация на общее видео включают following', () => {
  const pending = { ...initialView(a), pendingNavigation: { videoId: b, videoRevision: 0,
    operationToken: crypto.randomUUID(), source: { videoId: a, sequence: 0 } } };
  expect(observeRoute(pending, { videoId: b, sequence: 0 }, b, true)).toMatchObject({ mode: 'following' });
  const detached = observeRoute(initialView(a), { videoId: b, sequence: 1 }, a);
  expect(observeRoute(detached, { videoId: a, sequence: 2 }, a).mode).toBe('following');
  expect(observeRoute(detached, { videoId: a, sequence: 0 }, a)).toEqual(detached);
});
it('только подтверждённая собственная смена снимает detached после потери ack', () => {
  const view = { ...initialView(a), mode: 'detached' as const, pendingSwitch: { commandId: 'switch', videoId: b } };
  expect(reconcileView(view, { ...next, commandId: 'previous-own-action' }, true).pendingSwitch).toBeDefined();
  expect(reconcileView(view, next, false).mode).toBe('detached');
  expect(reconcileView(view, next, true)).toMatchObject({ mode: 'following', videoRevision: 1 });
  expect(reconcileView(view, next, true).pendingSwitch).toBeUndefined();
  expect(viewSchema.safeParse({ ...view, secret: 'bad' }).success).toBe(false);
});
it('промежуточная загрузка остаётся переходом комнаты после новой revision', () => {
  const pending = { ...initialView(a), pendingNavigation: { videoId: b, videoRevision: 0,
    operationToken: crypto.randomUUID(), source: { videoId: a, sequence: 0 } } };
  const latest = reconcileView(pending, next, false);
  expect(latest.pendingNavigation).toEqual(pending.pendingNavigation);
  expect(observeRoute(latest, { videoId: b, sequence: 0 }, a, true).mode).toBe('following');
  expect(reconcileView(latest, { ...next, revision: 0, videoRevision: 0 }, true, true)).toEqual(latest);
});
