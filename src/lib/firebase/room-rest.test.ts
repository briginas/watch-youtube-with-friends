import { expect, it, vi } from 'vitest';
import { readRoomRest } from './room-rest';
const config = { apiKey: 'public', projectId: 'test-project', databaseURL: 'https://project.firebaseio.com', invitationBaseUrl: 'https://invite.example/', emulators: false, backendGeneration: 'test-v1', controlProjectId: 'test-control' };
it('GET точной комнаты, прежний token, запрет cache/referrer; нет SDK сокета', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('null'));
  const token = vi.fn(async () => 'private-token');
  expect(await readRoomRest(config, 'a'.repeat(64), token, new AbortController().signal, request)).toBeNull();
  const [url, options] = request.mock.calls[0]!;
  expect(String(url)).toBe(`https://project.firebaseio.com/rooms/${'a'.repeat(64)}.json?auth=private-token`);
  expect(options).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  expect(token).toHaveBeenCalledTimes(1);
});
it('отмена token не позволяет поздний fetch', async () => {
  let resolve!: (token: string) => void;
  const controller = new AbortController(), request = vi.fn();
  const pending = readRoomRest(config, 'a'.repeat(64), () => new Promise(yes => { resolve = yes; }), controller.signal, request);
  controller.abort(); await expect(pending).rejects.toThrow(); resolve('private-token'); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
});
it.each([401, 403, 429, 500])('HTTP %s не выводит token/тело и не означает квоту', async status => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-token raw quota error', { status }));
  await expect(readRoomRest(config, 'a'.repeat(64), async () => 'private-token', new AbortController().signal, request)).rejects.toThrow(status === 401 || status === 403 ? 'access-denied' : 'network-or-timeout');
});
it('ошибка/истечение token сохраняет категорию Auth без секрета и без запроса', async () => {
  const request = vi.fn();
  const pending = readRoomRest(config, 'a'.repeat(64), async () => { throw Object.assign(new Error('private-token in sdk details'), { code: 'auth/user-token-expired' }); }, new AbortController().signal, request);
  await expect(pending).rejects.toThrow('auth-failed'); expect(request).not.toHaveBeenCalled();
});
