import { roomKeySchema } from './key';
import { backendGeneration } from '../firebase/config';

export { initialPlaybackSchema, type InitialPlayback } from '../playback/model';

export function generateRoomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function invitationUrl(baseUrl: string, key: string): string {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = new URLSearchParams({ generation: backendGeneration, room: roomKeySchema.parse(key) }).toString();
  return url.href;
}
