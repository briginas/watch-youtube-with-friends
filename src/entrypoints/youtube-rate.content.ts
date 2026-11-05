import { defineContentScript } from 'wxt/utils/define-content-script';
import { installPlayerRateBridge } from '../lib/player/rate-bridge';

export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() { installPlayerRateBridge(); },
});
