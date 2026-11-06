> Публичная копия: сведения оператора обезличены; example IDs и контакты не являются действующей конфигурацией. Исторические результаты не подтверждают текущее состояние сервера.

# Verification — 0.1.0, 2026-11-04

Первоначальная проверка ниже сохранена как история. Публикация и Store installation
завершены на 0.2.6 2026-11-06; актуальное подтверждение — в последнем разделе.

## Артефакт и исходники

ZIP: `.output/release/watch-together-0.1.0.zip`, 19 файлов, SHA-256:
`2f91485dd773f3c9e1ec20cfcb2bae2965e820a472f45eddaceca0fe2aa04366`.
Базовый commit: `990c0e25e62088a5c034b202ad57ee3ab1306a74`.
Сборка включает незакоммиченные изменения; этот commit сам по себе не воспроизводит release.
SHA-256 перечня исходных файлов и их hashes:
`be5d62f80353e8be22a2c5fba8c745d366b932e1cc68cd98e33d90d52b305af1`.
Полный обезличенный inventory исходников, пакета и production-ресурсов — `docs/release-evidence.json`.
После загрузки ZIP не пересобирался и не перепаковывался. Повторная распаковка и аудит
подтвердили совпадение всех файлов с исходным audit report, findings = [].

Фактическое окружение: Node 26.3.0, WXT 0.21.5, firebase-tools 15.34.2,
Playwright 1.64.1 / Chromium 156 на macOS. `.nvmrc` требует Node 24.19.0;
результаты ниже получены на указанной фактической версии, воспроизведение на Node 24 не проверено.

## Выполненные команды

| Проверка | Exit | Результат |
|---|---:|---|
| `npm run typecheck` | 0 | WXT prepare + TypeScript; invitation entrypoints пропускаются обычным режимом без server config |
| `npm test` | 0 | 23 файла, 223 теста, включая 32 release tests |
| `npm run test:integration` | 0 | 52 integration tests, 3 файла |
| `npm run build` | 0 | Обычная сборка; production project ID в output отсутствует |
| `npm run build:transport` | 0 | Emulator transport build |
| `npm run release:build` | 0 | Отдельный production output + ZIP, распаковка, аудит, SHA-256 |
| `npm run release:deploy` | 0 | Только production database, auth, hosting |
| `node node_modules/@playwright/test/cli.js test --config playwright.release.config.ts hosting.spec.mjs` | 0 | Pending/published Hosting в настоящем Chromium |
| `node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together "node node_modules/@playwright/test/cli.js test --config playwright.transport.config.ts invitation.spec.ts"` | 0 | 5 invitation/privacy browser tests |
| `RELEASE_SMOKE=1 RELEASE_HEADED=1 node node_modules/@playwright/test/cli.js test --config playwright.release.config.ts production.spec.ts` | 0 | 1 production smoke, 42.6 s; два независимых profiles, реальный YouTube |
| `npm run spec:validate` | 0 | 3 validations, 0 failed |
| `git diff --check` | 0 | Без whitespace errors |

Production smoke: Anonymous Auth, создание, приглашение/вход, общая команда,
выход создателя обычным кликом (click listener получил 1 событие), presence 2→1,
повторное открытие из каталога и presence 1→2. Credentials/UID/room secret в отчёт не выводились.
Raw sanitized report сохранён в `.output/release/production-smoke.json` и скопирован в evidence.
Signup и refresh токена после API restrictions вернули 200; корневое чтение RTDB
без Auth и с обычным Anonymous Auth возвращает 401. Privacy/root HTTPS 200, headers проверены.

## Ошибки проверки и ограничения

Ранние попытки production smoke выявляли ошибки порядка действий теста (lazy iframe,
готовность кнопки, свёрнутая панель). Headless pointer click в cross-origin iframe
не доставлялся кнопке; Enter проходил. Повтор headed smoke подтвердил настоящий
pointer click и весь сценарий без fallback. Код продукта ради прохождения не менялся.
Первый emulator browser запуск в sandbox получил EPERM; разрешённый повтор завершился успешно.
Команда через голый `playwright` в emulators:exec не нашла executable (127), исправлена
на прямой Node CLI. Первичная загрузка Store была отклонена из-за отсутствия 2-Step
Verification; владелец включил её, повторная загрузка принята.

Это smoke двух profiles на одном Mac и одной сети. Независимые сети, естественная реклама,
длительное воспроизведение и Store installation ещё не приняты. Runtime IndexedDB содержит
Auth tokens, локальный каталог — room secrets; они не включены в ZIP/evidence.
Статический аудит покрывает известные форматы и переданные секреты, а не все возможные утечки.
Автоматическое удаление серверных комнат и App Check не реализованы; policy/runbook это отражают.

## Chrome Web Store

Аккаунт `operator@example.invalid`, publisher `briginas`, Contact email Verified:
`support@example.invalid`. Item `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
Dashboard показывает draft package 0.1.0 и permissions activeTab, clipboardWrite, storage,
host permission. Listing, privacy, реальный screenshot, icon и test instructions сохранены.
Distribution: Public, Free of charge, All regions. Remote code: No.
Disclosures: PII (anonymous ID), Authentication, Location (Firebase IP), Web history,
User activity, Website content. Health/financial/personal communications не собираются.
Для review выключена автоматическая публикация. Dashboard подтвердил «Your extension was submitted for review» и статус **Pending review**
2026-11-04. Deferred publishing включён (автоматическая публикация выключена).
Одобрение/публикация/Store installation пока не подтверждены.


## Завершение публичного выпуска — 0.2.6, 2026-11-06

Пользователь подтвердил публикацию. Независимая проверка dashboard показывает
Published package 0.2.6, публичная карточка — Version 0.2.6 и кнопку Add to Chrome.
Privacy в публичной карточке уже указывает на постоянный control Hosting.
Точные Store/project IDs и локальные доказательства остаются вне Git.

Загруженный при подготовке 0.2.6 ZIP собран после чистого commit `4ad0b28`:
SHA-256 `9119f7b581f659ec465759fdaef30197a8b1df8a7ae6c79e9fd699bcbb2dc438`.
При подготовке этого пакета прошли typecheck, 304 unit-теста, spec validation
и release build/audit. Новая локальная версия 0.2.7 не загружалась в Store в рамках
финализации; её артефакты не подменяют контрольную сумму опубликованной 0.2.6.

### Hosting

В локальном production env включены фактический Store ID и
`RELEASE_STORE_PUBLISHED=1`. Control Hosting собран с текущим публичным реестром,
затем опубликован Hosting-only командой. Backend/Auth/Rules не разворачивались.
Файлы Hosting и генератор не изменялись с commit выпуска 0.2.6.

| Проверка | Exit | Результат |
|---|---:|---|
| `npm run release:prepare-control -- <snapshot текущего реестра>` | 0 | Рабочая ссылка Store, ожидание публикации выключено |
| `npm test -- tests/release/hosting.test.mjs tests/release/control.test.mjs` | 0 | 7 тестов, 2 файла |
| `npm run release:deploy-control` | 0 | Только control Hosting, Deploy complete |
| Публичная HTTP-проверка, 12:52:27 UTC | 0 | HTTPS 200; ожидаемая Store-ссылка; pending=false; реестр побайтно не изменился; CSP, no-referrer, nosniff присутствуют |

Команды финализации выполнялись с Node 24.19.0. Санитизированный live-отчёт:
`.local/release-finalization/hosting-check.json`.

### Store smoke в обычном Chrome

На одном Mac в одной сети использованы независимые профили Watch Together QA A/B.
В обоих прежняя unpacked 0.2.5 отключена, 0.2.6 установлена именно через Store.
Установленная версия и официальный extension ID проверены через popup.

1. Профиль A: установка, открытие настоящего YouTube, соединение с backend,
   создание комнаты; popup показывает одного участника.
2. Профиль B без активного расширения: приглашение показывает установку из Store
   и инструкцию вернуться и обновить страницу. Ссылка Store не содержит fragment.
3. Переход по этой ссылке, установка 0.2.6, возврат кнопкой Back: доступна кнопка
   «Присоединиться». Дополнительный reload не понадобился.
4. Явный вход открывает отдельную вкладку с тем же видео. Оба popup показывают
   0.2.6, одну и ту же комнату, «Комната подключена» и двух участников.
5. Play в профиле B запускает видео в A; Pause в A останавливает видео в B.
   Наблюдения UI подтверждают доставку, без измерений задержки или revision.

Локальные снимки без приглашений/UID/токенов:
`.local/release-finalization/store-profile-a.jpg` и `store-profile-b.jpg`.
В QA-профилях оставлена установленная Store-версия; прежняя unpacked отключена,
проверочное видео остановлено общей паузой. Основной профиль не изменён.

README, PRD, backend ADR и runbook обновлены. Разные сети, естественная реклама,
длительное воспроизведение, полный security audit и полная приёмка MVP не заявляются.
Удаление legacy Firebase — отдельное изменение и не условие этого архива.

При синхронизации уточнено «production-окружение» вместо единственного проекта:
это согласует исходный release-сценарий с уже принятым `backend-generations`,
разделяющим backend и control Hosting. Требование изоляции от QA сохраняется.

### Завершение OpenSpec

Все 18 задач выполнены; пять требований синхронизированы в основную
`extension-distribution` с проверкой Purpose и полного совпадения requirement blocks.
`openspec validate --specs`: 7 passed, 0 failed. После переноса архива
`npm run spec:validate`: 8 passed, 0 failed; `npm run repo:audit`: 438 items,
0 findings; `git diff --check`: exit 0. Change `remove-legacy-deployment`
остаётся активным: privacy подтверждена, запрос удаления проекта не выполнен.
