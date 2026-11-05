> Публичная копия: сведения оператора обезличены; example IDs и контакты не являются действующей конфигурацией. Исторические результаты не подтверждают текущее состояние сервера.

# Проверка manage-production-generations

2026-11-04. Реализация и обязательные проверки завершены. Production rollout
и Chrome Web Store остаются отдельными этапами.

## Результаты

| Команда | Exit | Что проверено |
| --- | --- | --- |
| `npm run typecheck` | 0 | TypeScript и WXT |
| `npm test` | 0 | 292 unit/release теста в 35 suites, включая снимки, ZIP, статус и ротацию |
| `node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together 'node_modules/.bin/vitest run --config vitest.integration.config.ts'` | 0 | 54 теста на настоящих эмуляторах Anonymous Auth/RTDB Rules, 4 suites |
| `npm run build:transport` | 0 | Локальная конфигурация `emulator-v1` и пакет 0.2.0 |
| `playwright test --config playwright.transport.config.ts invitation.spec.ts generations.spec.ts creation.spec.ts catalog.spec.ts capacity.spec.ts` под эмуляторами | 0 | 27 passed, 1 skip реального YouTube |
| `playwright test --config playwright.transport.config.ts generations.spec.ts sync.spec.ts invitation.spec.ts` под эмуляторами с `GENERATION_FIXTURE_EXTENSION` | 0 | 11 passed, 1 skip альтернативного live-режима того же стенда |
| `playwright test --config playwright.release.config.ts hosting.spec.mjs` | 0 | 2 браузерные проверки HTTP fixtures без расширения, CSP, no-referrer, Store и privacy |
| `npm run build` | 0 | Обычная сборка без Firebase-настроек |
| `WXT_BACKEND_GENERATION=qa-v1 WXT_CONTROL_PROJECT_ID=example-qa npm run build:cloud` | 0 | QA-сборка из локального `.env.cloud` с явными параметрами нового формата |
| `WXT_BACKEND_GENERATION=qa-v1 WXT_CONTROL_PROJECT_ID=example-qa npm run deploy:cloud` | 0 | Auth, Rules и Hosting опубликованы в существующем QA-проекте |
| Live smoke, команда ниже | 0 | 1 passed на настоящем YouTube, 47.4 с |
| Изолированные `release:prepare -- new 0.2.0 legacy`, `release:prepare-backend`, `release:prepare-control`, `release:build`, `release:audit` | 0 | Сборка и аудит ZIP fixture 0.3.0, 20 файлов |
| `openspec validate manage-production-generations --strict --no-interactive`, `npm run spec:validate`, `git diff --check` | 0 | Delta, основные specs и рабочие изменения |

## Локальная матрица

- Два независимых профиля входят в комнату своего поколения через настоящий эмулятор
  Anonymous Auth и Rules. На управляемом плеере проверены play/pause, seek, rate,
  авторство и одна серверная revision на действие.
- Метаданные совместимого patch допускаются. При недоступном реестре своё поколение
  по-прежнему входит. Два пакета с разными поколениями отвергают чужое приглашение
  в обоих направлениях до Auth и базы. Для этого использованы эмуляторный пакет
  `emulator-v1` и изолированный release-пакет `g-fixture` с HTTP fixtures.
- Подтверждённый retired имеет приоритет над busy и блокирует вход и создание из popup
  без Auth, REST и сокета. Отдельные HTTP fixtures проверяют страницу без расширения.
- Отмена блокирует запоздалые Auth/REST и открытие вкладки. Проверены reload, restart
  worker и teardown после `chrome.runtime.reload()`. Эта проверка покрывает
  выгрузку runtime в unpacked extension, а обновление через Store требует rollout.
- Watch использует максимум один realtime socket. Read-only вход использует REST
  без сокета. Stop/retry сохраняют привязку и локальный detached-просмотр.

## Live QA

```sh
QA_GENERATION_SMOKE=1 WXT_BACKEND_GENERATION=qa-v1 \
  WXT_CONTROL_PROJECT_ID=example-qa \
  node --env-file=.env.cloud node_modules/@playwright/test/cli.js test \
  --config playwright.cloud.config.ts generation-smoke.spec.ts
```

Публичный реестр QA перед публикацией отвечал HTTP 404. После публикации два
временных Chromium-профиля на настоящем YouTube подтвердили приглашение нового
формата, CSP/no-referrer, Anonymous Auth и REST, совместный вход, одну принятую
revision без эха и восстановление binding через stop/retry. Счётчик HTTP-запросов
к посторонним Firebase endpoints равен 0. Данные с ключами комнат, UID и токенами
в отчёт не включены. QA smoke покрывает один общий ввод на одной машине и сети.

## Происхождение релиза и ограничения

Проверочный ZIP собран во временной копии рабочего дерева, отдельно от настоящего
`.env.production`, с синтетическими project IDs `fixture-backend` / `fixture-control`
и поколением `g-fixture`. Подготовка и аудит выполнились локально. QA, эмулятор и
обычный пакет проверены на отсутствие известных production endpoints. Версия
репозитория остаётся 0.2.0. Production IDs нового поколения и контрольного сайта
выбираются при rollout. Legacy описан по runbook, его снимок получен из репозитория.

Ротация проверена на fake cloud adapter, включая 403, неизвестный исход, повтор
плана, изменение revision, занятую квоту и восстановление. Для реальной ротации
потребуется облачный адаптер. Операции с production и Store в рамках change
не выполнялись.

Промежуточные прогоны выявили устаревшие проверки metadata и нестабильность клика
в extension iframe при обновлении страницы Hosting. Положение iframe закреплено,
повторные доставки одного приглашения не сбрасывают вход. Часть тестов явно
проверяет клавиатурное действие. Финальные прогоны перечислены выше.
