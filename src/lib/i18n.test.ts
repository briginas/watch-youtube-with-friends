import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import english from '../../public/_locales/en/messages.json' with { type: 'json' };
import russian from '../../public/_locales/ru/messages.json' with { type: 'json' };
import { t, uiLanguage, type MessageKey } from './i18n';
import { connectionMessage } from './room/status';
import { failureMessage } from './connection-error';
import type { TransportState } from './room/transport';

afterEach(() => vi.unstubAllGlobals());

describe('локализация расширения', () => {
  it('содержит полные словари с одинаковыми подстановками и корректными ключами HTML', () => {
    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as MessageKey[]) {
      expect(english[key].message.trim(), key).not.toBe('');
      expect(russian[key].message.trim(), key).not.toBe('');
      expect(english[key].message, key).not.toMatch(/[А-Яа-яЁё]/);
      expect(english[key].message.match(/\$(?:\d|[a-z][\w]*\$)/gi) ?? [], key)
        .toEqual(russian[key].message.match(/\$(?:\d|[a-z][\w]*\$)/gi) ?? []);
      const message = english[key] as { message: string; placeholders?: Record<string, { content: string }> };
      expect(message.placeholders, key).toEqual((russian[key] as typeof message).placeholders);
      for (const [, name] of message.message.matchAll(/\$([\w]+)\$/g)) expect(message.placeholders, key).toHaveProperty(name!);
    }
    for (const path of ['session.html', 'invitation.html', 'popup/index.html']) {
      const html = readFileSync(new URL(`../entrypoints/${path}`, import.meta.url), 'utf8');
      for (const [, key] of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) expect(english).toHaveProperty(key!);
      expect(html).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it.each(['ru', 'ru-RU', 'ru_BY', 'RU'])('выбирает русский lang для %s', locale => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => locale } });
    expect(uiLanguage()).toBe('ru');
  });

  it.each(['en', 'en-US', 'de', 'uk', 'rue'])('выбирает английский lang для %s', locale => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => locale } });
    expect(uiLanguage()).toBe('en');
  });

  it('использует Chrome getMessage и передаёт подстановки без изменения', () => {
    const getMessage = vi.fn(() => 'Participants: 2');
    vi.stubGlobal('chrome', { i18n: { getMessage } });
    expect(t('participantCount', '2')).toBe('Participants: 2');
    expect(getMessage).toHaveBeenCalledWith('participantCount', '2');
  });

  it('работает вне runtime и с fake-browser WXT на английском', () => {
    for (const chrome of [undefined, { i18n: { getMessage: () => '', getUILanguage: () => 'de' } },
      { i18n: { getMessage: () => { throw new Error('not implemented'); }, getUILanguage: () => { throw new Error('not implemented'); } } }]) {
      vi.stubGlobal('chrome', chrome);
      expect(uiLanguage()).toBe('en');
      expect(t('participant', ['2', ' (you)'])).toBe('Participant 2 (you)');
      expect(failureMessage({ kind: 'not-found', stage: 'read', retryable: false })).toBe('Room not found.');
    }
  });

  it('переводит динамическую ошибку, время повтора и локальный режим', () => {
    const state = { error: failureMessage({ kind: 'not-found', stage: 'read', retryable: false }),
      room: 'room', connected: false, recovery: { phase: 'waiting', retryAt: Date.now() + 10_000 } } as TransportState;
    expect(connectionMessage(state)).toContain('Комната не найдена. Следующая попытка через 10 с.');
    expect(connectionMessage(state)).toContain('Просмотр остаётся локальным.');
  });
});
