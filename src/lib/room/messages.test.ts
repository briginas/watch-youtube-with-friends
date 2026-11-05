import { describe, expect, it } from 'vitest';
import { isPopupSender, sessionRequestSchema } from './messages';

describe('граница session bridge', () => {
  const target = 'c36b326c-f235-4cc2-a784-d5fa634c68aa';
  it('принимает только собственный popup', () => {
    expect(isPopupSender({ id: 'ours', url: 'chrome-extension://ours/popup.html' }, 'ours')).toBe(true);
    for (const sender of [
      { id: 'other', url: 'chrome-extension://ours/popup.html' },
      { id: 'ours', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
      { id: 'ours', url: 'chrome-extension://ours/session.html' },
      { id: 'ours', url: 'chrome-extension://ours/popup.html?spoof=1' },
      {},
    ]) expect(isPopupSender(sender, 'ours')).toBe(false);
  });
  it('отклоняет произвольный путь, пустой адрес и лишние поля', () => {
    const request = { type: 'room-session', backendGeneration: 'emulator-v1', action: 'watch', target, key: 'a'.repeat(32) };
    expect(sessionRequestSchema.safeParse(request).success).toBe(true);
    for (const key of ['', '../rooms', 'a/b', '_probes/x', 'a'.repeat(129)]) {
      expect(sessionRequestSchema.safeParse({ ...request, key }).success).toBe(false);
    }
    expect(sessionRequestSchema.safeParse({ ...request, target: '' }).success).toBe(false);
    expect(sessionRequestSchema.safeParse({ ...request, uid: 'spoof' }).success).toBe(false);
  });
});
