> Публичная копия: сведения оператора обезличены; example IDs и контакты не являются действующей конфигурацией. Исторические результаты не подтверждают текущее состояние сервера.

# Проверка natural-seek-order

Дата: 2026-11-03. Реализация завершена. Database Rules опубликованы в QA; на момент архивирования live-приёмка новых сценариев на YouTube не выполнялась. Последующая [live-проверка](../../../../docs/experiments/youtube-seek-order-acceptance-2026-11-03.md) подтвердила основные сценарии; ограничение дальнего seek в автоматизированном Chromium записано отдельно.

## Результаты

| Проверка | Результат |
| --- | --- |
| `npm test` | 14 файлов, 161 тест — passed |
| `npm run test:integration` | 3 файла, 46 тестов — passed; Anonymous Auth и RTDB Rules под Firebase Emulator Suite |
| `npm run test:player` | 21 тест — passed; настоящий Chromium и seekable media на управляемой странице |
| Полный room-transport прогон | 32 passed, 17 skipped (opt-in YouTube), 3,3 минуты |
| `npm run typecheck` | passed |
| `npm run build`, `npm run build:transport`, `npm run build:cloud` | passed |
| `npm run spec:validate` | change перед архивированием и обе основные specs — passed, strict |
| `git diff --check` | passed |

Команда полного прогона после `npm run build:transport`:

```sh
node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together 'node_modules/.bin/playwright test --config playwright.transport.config.ts'
```

Проверены оба направления play/pause/seek/rate, разные профили и UID, удержание клавиши с начальной паузой автоповтора, объединение коротких нажатий, drag, отмена по blur, защита жеста от remote apply, сохранение только последнего действия во время записи и отсутствие промежуточного локального отката. Задержка исходного пакета настоящего SDK воспроизводит обратную доставку: более поздний seek другого участника не заменяется ранним. Unit/integration дополнительно проверяют равные метки, повторы после записи поверх старой базы, границы меток и расчёт позиции с учётом времени считывания. Регрессии reconnect, локальных настроек, рекламы/buffering, ошибок видео и autoplay прошли на стенде.

## Границы

- Первоначальная проверка при архивировании использовала управляемый видеостенд; opt-in конфликтный live-тест тогда ещё не запускался. Последующие результаты настоящего YouTube приведены в отдельном отчёте выше.
- Обратная совместимость не поддерживается. Метки обязательны с revision 0; Database Rules в QA обновлены. Собранное расширение устанавливается отдельно.
- Порядок действий разных устройств ограничен погрешностью оценки серверных часов. При равных метках сохраняется первая принятая команда.
- Основная spec shared-playback синхронизирована: обновлено согласование конфликтов, добавлены завершение жеста и сохранение последнего действия.

## Деплой Database Rules

`npm run deploy:rules` успешно развернул только RTDB Rules в `example-qa`, instance `example-qa-default-rtdb` (europe-west1). Hosting и Auth не менялись. Облачный файл получен из emulator Rules с удалением `_probes`.

Независимая проверка: Firebase CLI `database:get /.settings/rules` скачал активные Rules после деплоя. Сравнение разобранных JSON с `.output/cloud/database.rules.json` подтвердило полное совпадение; `_probes` отсутствует. SHA256 скачанного файла: `86cdbe9ade36ff262d1aee5d24acb6f6fda6f51e805ce808f4de8302c72e990c`.

Все 5 задач выполнены. Change архивирован в `openspec/changes/archive/2026-11-03-natural-seek-order/` после синхронизации и проверки основной spec.
