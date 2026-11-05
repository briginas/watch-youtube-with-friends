import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { createProbe } from '../client';

export default defineBackground(() => {
  globalThis.firebaseProbe = createProbe();
  globalThis.probePopupCount = async () => (await browser.runtime.getContexts({ contextTypes: ['POPUP'] })).length;
  globalThis.openProbePopup = async (probeId) => {
    await browser.action.openPopup();
    return browser.runtime.sendMessage({ type: 'firebase-probe-popup-start', probeId });
  };
  globalThis.closeProbePopup = async () => {
    await browser.runtime.sendMessage({ type: 'firebase-probe-popup-close' });
  };
  // Экспериментальный popup будит worker только по явному запросу.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || message?.type !== 'firebase-probe-start') return;
    firebaseProbe.start(message.probeId).then(
      (state) => sendResponse({ uid: state.uid, instance: state.instance }),
      () => sendResponse({ error: 'Probe startup failed' }),
    );
    return true;
  });
});
