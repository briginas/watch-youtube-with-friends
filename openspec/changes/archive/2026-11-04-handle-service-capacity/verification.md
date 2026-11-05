# Проверка handle-service-capacity

Дата: 2026-11-04. Node 24, macOS, Playwright Chromium. Изменения проверяются из рабочего дерева;
commit в release metadata указывает базовый HEAD, наличие незакоммиченных изменений отмечено явно.

## Проверки

| Команда | Exit code | Результат |
| --- | --- | --- |
| `npm run typecheck` | 0 | TypeScript и WXT types |
| `npm test` | 0 | 28 файлов, 261 тест; parser, deadlines, retry/cancel, REST, transport и release launcher |
| `npm run build` | 0 | Обычная Chrome MV3 сборка |
| `npm run test:integration` | 0 | 4 файла, 53 теста; настоящий Auth/Rules на эмуляторах, REST и Hosting headers |
| `npm run build:transport` | 0 | Сборка с emulator endpoints, штатной CSP, без probe permissions |
| `node_modules/.bin/playwright test --config playwright.release.config.ts` | 0 | 1 passed; production smoke отдельно opt-in, 1 skipped |
| `npm run status:prepare -- operational - 3600` | 0 | Только локальные JSON и Hosting-only config; deploy не выполнялся |
| `npm run spec:validate` | 0 | 4 change/spec items, strict validation, 0 failed |
| `git diff --check` | 0 | Ошибок whitespace нет |

Integration и transport запускаются внутри
`node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together "<команда>"`.
Sandbox без разрешения loopback не позволяет поднять эмуляторы; повтор с разрешёнными локальными
портами выполнен. Это ограничение среды, а не результат прохождения тестов.

### Browser-матрица

Первый широкий прогон: `capacity.spec.ts invitation.spec.ts catalog.spec.ts reconnect.spec.ts
presence.spec.ts creation.spec.ts lifecycle.spec.ts tabs.spec.ts page-ui.spec.ts video-switch.spec.ts`
через `playwright.transport.config.ts`: 61 passed, 1 failed, 5 skipped, exit 1.
Проверены каталог, создание, presence, две вкладки/профиля, UI, invitation, Auth и reconnect.
Ошибка оставалась в тесте reload: он ждал подключения до снятия собственной сетевой блокировки.
Тест исправлен: дождаться появления session frame, снять блокировку, затем ждать восстановления.

Следующий прогон `capacity.spec.ts video-switch.spec.ts`: 22 passed, 1 failed, 1 skipped, exit 1.
Все сценарии смены видео, включая оба обрыва before-server/before-ack, reload/worker restart,
поздние транзакции и отсутствие replay, прошли. Новые проверки зависшего Auth (общие 15 с),
потерянного ack создания и отмены внутри background также прошли.
Обнаружена гонка stop с синхронным callback SDK; состояние stopped и connected=false теперь
устанавливаются до goOffline. Добавлена регрессионная unit-проверка. Кнопка повтора в popup
теперь явно возобновляет transport, что проверяется через настоящий UI.

Финальный прогон после исправлений:
`node_modules/.bin/playwright test --config playwright.transport.config.ts capacity.spec.ts
reconnect.spec.ts page-ui.spec.ts lifecycle.spec.ts` — exit 0, **25 passed, 2 skipped**.
Ему предшествовал успешный integration run: 4 файла, 53 теста, exit 0.
Подтверждены ноль живых сокетов после stop, восстановление кнопкой popup с новым REST,
сохранение комнаты и работа watch после закрытия popup; все новые capacity tests прошли.
Skip — opt-in live YouTube; результаты QA ниже не подменяют эти suites.

### QA с настоящим YouTube

```sh
npm run build:cloud
CAPACITY_QA=1 node --env-file=.env.cloud node_modules/@playwright/test/cli.js test --config playwright.cloud.config.ts capacity.spec.ts
```

Обе команды: exit 0; 1 passed (повторный smoke — 54.1 с). Тест отказывается работать с project ID
без QA-маркера. Два изолированных профиля, разные Anonymous UID, вход через приглашение с REST
и штатной CSP, два участника, один общий seek/одна revision без эха, offline локально,
stop с сохранением binding, ручное восстановление со свежим чтением, detached после reconnect.
Обезличенный отчёт — `qa-smoke.json`; токены, UID и ключи комнат не сохраняются в нём.
Этот отчёт сохраняется вместе с архивом change. Последующие запуски QA-теста пишут
`.output/cloud/capacity-smoke.json`, не изменяя архив и не создавая change заново.

## Метод проверки соединений и границы доказательства

Playwright подписан на WebSocket events всех страниц профиля, считает живые RTDB WebSocket
и их максимум, уменьшает счётчик по close. Для watch проверяются максимум один одновременно,
REST при входе/восстановлении, ноль после stop и сохранение binding. Для приглашения проверяются
ноль WebSocket и отсутствие presence до открытия YouTube. Повторное приглашение активирует
существующую вкладку без нового REST. Закрытие popup не закрывает watch transport.

REST проверен с тем же пользовательским ID token и действующими Rules: точная комната доступна,
без Auth и при попытке перечисления отказ, отсутствующая комната возвращает null,
неподдерживаемый формат отклоняется клиентом. Чтение не использует временный Firebase App.
Сетевые trace/скриншоты с приватными ответами отключены.

Это клиентские наблюдения, а не измерение внутреннего учёта Firebase connections или стоимости.
REST расходует HTTP-трафик. Подставленный status quota проверяет UX, но не настоящий отказ Spark.
Production до лимита не заполнялся. QA выполнен на одном Mac и в одной сети; пропущенные live
YouTube suites и opt-in production smoke не считаются пройденными на основании emulator tests.
Публичный JSON — ручное объявление с TTL; до отдельного Hosting deploy файл на сайте не обновится.

## Выпуск

`npm run release:build`, затем `npm run release:audit` и `npm run release:hosting`: exit 0.
Версия в package.json, обеих метаданных package-lock.json, готовом manifest и manifest внутри ZIP —
`0.2.0`. Пакет: `.output/release/watch-together-0.2.0.zip`, 20 файлов.
SHA-256: `cc4deab3a3eb8cd8a9272d5e50fb4279c8ce2a900f56fd0aad404c7072822a1f`.
Повторный аудит дал тот же SHA-256, findings пуст. Отчёт и inventory находятся рядом:
`watch-together-0.2.0.zip.audit.json`, `watch-together-0.2.0.zip.sha256`, `build-info.json`.

Privacy и Store disclosures дополнены публичным status HTTP и авторизованным точечным REST.
Новые permissions не добавлены; connect-src дополнен точным существующим Hosting origin.
Инструкции подготовки, Hosting-only публикации, снятия инцидента и отката — `docs/release.md`.
Публикация Hosting, изменение тарифа, загрузка ZIP в Store и Publish в этой работе не выполнялись.
