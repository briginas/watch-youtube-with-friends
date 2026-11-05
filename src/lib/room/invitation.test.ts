import { describe, expect, it } from 'vitest';
import { invitationKey, invitationRequestSchema, invitationRoomSchema, isInvitationPage, isInvitationSender } from './invitation';

describe('доверенное приглашение', () => {
  const base = 'http://127.0.0.1:5002/';
  const key = 'a'.repeat(64);
  const url = `${base}#generation=emulator-v1&room=${key}`;
  it('принимает ровно один полный секрет только по настроенному адресу', () => {
    expect(invitationKey(url, base)).toBe(key);
    for (const value of [base, `${base}#room=${key}`, `${base}#generation=emulator-v1&room=short`, `${url}&room=${key}`, `${url}&uid=spoof`,
      `${url}&generation=other`, url.replace('emulator-v1', '../other'),
      `${base}#room=../rooms`, `${base}?room=${key}`, `${base}else#room=${key}`,
      url.replace('5002', '5003'), url.replace('127.0.0.1', 'localhost'),
      url.replace('127.0.0.1', '127.0.0.1.evil.example'), url.replace('http:', 'https:'),
      `http://user@127.0.0.1:5002/#room=${key}`, 'garbled']) {
      expect(invitationKey(value, base)).toBeNull();
    }
    expect(isInvitationPage(`${base}else`, base)).toBe(false);
  });
  it('требует собственный content script верхнего frame доверенного origin', () => {
    const sender = { id: 'ours', url, frameId: 0, tab: { id: 1 } };
    expect(isInvitationSender(sender, 'ours', base)).toBe(true);
    for (const patch of [{ id: 'other' }, { frameId: 1 }, { tab: undefined },
      { url: 'https://www.youtube.com/' }, { url: url.replace('5002', '5003') },
      { url: 'chrome-extension://ours/popup.html' }]) {
      expect(isInvitationSender({ ...sender, ...patch }, 'ours', base)).toBe(false);
    }
    const request = { type: 'room-invitation', target: crypto.randomUUID(), key, backendGeneration: 'emulator-v1' };
    expect(invitationRequestSchema.safeParse(request).success).toBe(true);
    expect(invitationRequestSchema.safeParse({ ...request, uid: 'spoof' }).success).toBe(false);
    expect(invitationRequestSchema.safeParse({ ...request, target: '' }).success).toBe(false);
    expect(invitationRequestSchema.safeParse({ ...request, key: '../rooms' }).success).toBe(false);
  });
  it('не принимает отсутствующее видео и некорректное состояние комнаты', () => {
    const room = { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: { videoId: 'aqz-KE-bpKQ', positionSeconds: 12,
      playbackRate: 1.5, isPlaying: false, revision: 0, kind: 'playback' as const, videoRevision: 0, actionAt: Date.now(), sampledAt: Date.now(), updatedAt: Date.now(), actorUid: 'uid', commandId: 'command' } };
    expect(invitationRoomSchema.safeParse(room).success).toBe(true);
    for (const playback of [{ ...room.playback, videoId: 'bad' }, { ...room.playback, positionSeconds: -1 },
      { ...room.playback, isPlaying: 'false' }, { ...room.playback, revision: 0.5 }]) {
      expect(invitationRoomSchema.safeParse({ playback }).success).toBe(false);
    }
    expect(invitationRoomSchema.safeParse(null).success).toBe(false);
  });
});
