# Tasks

## 1. История релизов без legacy

- [x] 1.1 Реализовать явный initial/null, убрать специальные ветки legacy, сохранить проверки new/reuse; unit-тесты покрывают первый релиз, повторный initial, неверные аргументы, отсутствующего предшественника и хэши.
- [x] 1.2 Перевести example/локальный начальный descriptor на null, удалить legacy snapshots/env и очистить fixtures; release-сборка 0.2.6 использует прежние prod-v1 IDs и хэши.
- [x] 1.3 Обновить README, configuration/development/release/store docs по актуальному процессу; исторические архивы и evidence сохранены, активные инструкции не требуют legacy.

## 2. Отключение старого проекта

- [ ] 2.1 Проверить control privacy по HTTPS, заменить URL в Store и подтвердить публичную карточку; сохранить наблюдение без credentials.
- [ ] 2.2 Live-проверить legacy project ID и роли остальных проектов, запросить удаление только legacy, проверить состояние у провайдера и обновить локальный инвентарь; QA/control/prod-v1 остаются ACTIVE.

Privacy URL сохранён и отправлен на review без автопубликации; dashboard подтвердил
Pending review 2026-11-06. Публичная карточка всё ещё ссылается на старый Hosting.
Все четыре проекта подтверждены ACTIVE через Firebase API. Удаление не запрашивалось;
точные IDs и условия продолжения записаны в `.local/deployment/legacy-retirement.json`.
Задачи 2.1–2.2 остаются открытыми до внешнего review и публикации privacy URL.

## 3. Сквозные проверки

- [x] 3.1 Пройти typecheck, unit, repo audit, strict OpenSpec validation и release build/audit; записать результаты и проверить diff.

## Workflow follow-up

- После обязательных проверок синхронизировать specs, архивировать change и выполнить spec:validate.
- Создать локальный коммит только с файлами задачи.
