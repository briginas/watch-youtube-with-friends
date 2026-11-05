import { createProbe } from './client';

globalThis.firebaseProbe = createProbe();
// Нет postMessage bridge: UID и Auth остаются в extension origin.
addEventListener('pagehide', () => { void firebaseProbe.stop(); });
