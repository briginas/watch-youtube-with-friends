import { describe, expect, it } from 'vitest';
import { isExtensionFrameSender, tabBindingsSchema, tabRequestSchema } from './tab-messages';
import { initialView } from './view';

describe('граница управления watch-вкладками', () => {
  const target = 'c36b326c-f235-4cc2-a784-d5fa634c68aa';
  const sender = { id: 'ours', url: `chrome-extension://ours/invitation.html#${target}`, frameId: 3, tab: { id: 4 } };
  it('принимает только собственный адресованный extension iframe во вкладке', () => {
    expect(isExtensionFrameSender(sender, 'ours', 'invitation', target)).toBe(true);
    for (const spoof of [
      { ...sender, id: 'other' }, { ...sender, frameId: 0 }, { ...sender, tab: undefined },
      { ...sender, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
      { ...sender, url: `chrome-extension://ours/session.html#${target}` },
      { ...sender, url: `chrome-extension://ours/invitation.html?spoof=1#${target}` },
    ]) expect(isExtensionFrameSender(spoof, 'ours', 'invitation', target)).toBe(false);
    expect(isExtensionFrameSender(sender, 'ours', 'invitation', crypto.randomUUID())).toBe(false);
  });
  it('не позволяет передать произвольный URL, tabId или некорректный ключ', () => {
    const request = { type: 'room-tab-open', backendGeneration: 'emulator-v1', target, key: 'a'.repeat(64), videoId: 'aqz-KE-bpKQ', name: 'Fixture' };
    expect(tabRequestSchema.safeParse(request).success).toBe(true);
    for (const invalid of [
      { ...request, url: 'https://example.com/' }, { ...request, tabId: 3 },
      { ...request, key: '../rooms' }, { ...request, videoId: 'invalid' },
      { ...request, target: '' },
    ]) expect(tabRequestSchema.safeParse(invalid).success).toBe(false);
  });
  it('сохраняет только строгий контекст просмотра и адресованные маршруты', () => {
    const binding = { target, backendGeneration: 'emulator-v1', key: 'a'.repeat(64), name: 'Fixture', videoId: 'aqz-KE-bpKQ', view: initialView('aqz-KE-bpKQ') };
    expect(tabBindingsSchema.safeParse({ 4: binding }).success).toBe(true);
    for (const view of [{ ...binding.view, secret: 'bad' }, { ...binding.view, videoRevision: -1 },
      { ...binding.view, mode: 'unknown' }, { ...binding.view, pendingNavigation: { videoId: binding.videoId } }]) {
      expect(tabBindingsSchema.safeParse({ 4: { ...binding, view } }).success).toBe(false);
    }
    const message = { type: 'room-tab-route', backendGeneration: 'emulator-v1', target, route: { videoId: null, sequence: 1 } };
    expect(tabRequestSchema.safeParse(message).success).toBe(true);
    for (const patch of [{ sequence: -1 }, { sequence: 1.5 }, { videoId: 'invalid' }, { key: 'bad' }]) {
      expect(tabRequestSchema.safeParse({ ...message, route: { ...message.route, ...patch } }).success).toBe(false);
    }
  });
});
