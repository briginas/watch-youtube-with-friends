import { browser } from 'wxt/browser';
import { createProbe } from '../../client';

globalThis.firebaseProbe = createProbe();
addEventListener('pagehide', () => { void firebaseProbe.stop(); });
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return;
  if (message?.type === 'firebase-probe-popup-start') {
    firebaseProbe.start(message.probeId).then(sendResponse);
    return true;
  }
  if (message?.type === 'firebase-probe-popup-close') {
    sendResponse({ closing: true });
    setTimeout(() => window.close(), 0);
  }
});

// Управляется только тестом внутри extension origin; сайт не имеет доступа.
declare global {
  var wakeProbeWorker: (probeId: string) => Promise<{ uid: string; instance: string }>;
}
globalThis.wakeProbeWorker = (probeId) => browser.runtime.sendMessage({
  type: 'firebase-probe-start', probeId,
});
