import russian from '../public/_locales/ru/messages.json' with { type: 'json' };
import { formatMessage } from '../src/lib/i18n';

// Существующие unit-тесты проверяют русские сообщения явно, независимо от ОС.
Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: {
  i18n: {
    getUILanguage: () => 'ru',
    getMessage: (key: keyof typeof russian, substitutions: string | string[] = []) => {
      return russian[key] ? formatMessage(russian[key], substitutions) : '';
    },
  },
} });
