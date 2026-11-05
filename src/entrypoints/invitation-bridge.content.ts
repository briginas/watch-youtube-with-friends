import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { firebaseConfig } from '../lib/firebase/config';
import { parseInvitation, isInvitationPage } from '../lib/room/invitation';

export default defineContentScript({
  matches: [import.meta.env.WXT_RELEASE === '1' ? `${new URL(import.meta.env.WXT_FIREBASE_INVITATION_BASE_URL!).origin}/*`
    : import.meta.env.WXT_FIREBASE_EMULATORS === '1' ? 'http://127.0.0.1/*'
    : `${new URL(firebaseConfig()?.invitationBaseUrl ?? 'http://127.0.0.1/').origin}/*`],
  main(ctx) {
    const config = firebaseConfig();
    if (!config || !isInvitationPage(location.href, config.invitationBaseUrl) || window !== window.top) return;
    const target = crypto.randomUUID();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.src = `${browser.runtime.getURL('/invitation.html')}#${target}`;
    frame.title = 'Вход в комнату';
    frame.style.cssText = 'width:100%;height:240px;border:0;border-radius:12px;color-scheme:dark';
    shadow.append(frame);
    const fallback = document.querySelector<HTMLElement>('#installation');
    const deliver = async () => {
      try {
        const invitation = parseInvitation(location.href, config.invitationBaseUrl);
        const response = await browser.runtime.sendMessage({
          type: 'room-invitation', target, key: invitation?.key ?? null, backendGeneration: invitation?.backendGeneration ?? null,
        });
        if (response?.accepted === true && fallback) {
          fallback.dataset.extensionReady = 'true';
          fallback.hidden = true;
        }
      } catch { resetFallback(); }
    };
    function resetFallback() {
      if (!fallback) return;
      delete fallback.dataset.extensionReady;
      fallback.hidden = fallback.dataset.generationRetired === 'true';
    }
    frame.addEventListener('load', () => { void deliver(); });
    ctx.addEventListener(window, 'hashchange', () => { void deliver(); });
    (document.querySelector('#extension-join') ?? document.querySelector('main') ?? document.body).append(host);
    ctx.onInvalidated(() => { host.remove(); resetFallback(); });
  },
});
