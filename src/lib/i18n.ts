import type { browser } from 'wxt/browser';
import english from '../../public/_locales/en/messages.json' with { type: 'json' };

export type MessageKey = keyof typeof english;
type Message = { message: string; placeholders?: Record<string, { content: string }> };

export function formatMessage(message: Message, substitutions: string | string[] = []): string {
  const values = typeof substitutions === 'string' ? [substitutions] : substitutions;
  return message.message.replace(/\$([a-z][\w]*)\$/gi, (_, name: string) => message.placeholders?.[name.toLowerCase()]?.content ?? '')
    .replace(/\$(\d)/g, (_, index: string) => values[Number(index) - 1] ?? '');
}

function api() {
  return (globalThis as { chrome?: { i18n?: typeof browser.i18n } }).chrome?.i18n;
}

export function uiLanguage(): 'ru' | 'en' {
  try {
    return /^ru(?:[-_]|$)/i.test(api()?.getUILanguage() ?? 'en') ? 'ru' : 'en';
  } catch {
    return 'en'; // WXT импортирует entrypoints с fake-browser при сборке.
  }
}

/** Chrome выбирает UI locale и английский default_locale, без запросов к сети. */
export function t(key: MessageKey, substitutions: string | string[] = []): string {
  try {
    const translated = api()?.getMessage(key, substitutions);
    if (translated) return translated;
  } catch { /* WXT fake-browser не реализует i18n при импорте entrypoints. */ }
  // Чистые модули используются и вне расширения (unit-тесты/инструменты).
  return formatMessage(english[key], substitutions);
}

export function localizeDocument(doc: Document = document) {
  doc.documentElement.lang = uiLanguage();
  for (const element of doc.querySelectorAll<HTMLElement>('[data-i18n], [data-i18n-title], [data-i18n-aria-label]')) {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (key) {
      // Сохраняем вложенные элементы, например input внутри label.
      const text = element.firstChild;
      if (text?.nodeType === 3) text.textContent = t(key);
      else element.prepend(doc.createTextNode(t(key)));
    }
    for (const attribute of ['title', 'aria-label']) {
      const attributeKey = element.getAttribute(`data-i18n-${attribute}`) as MessageKey | null;
      if (attributeKey) element.setAttribute(attribute, t(attributeKey));
    }
  }
}
