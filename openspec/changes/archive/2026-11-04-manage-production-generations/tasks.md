# Tasks

План и результаты реализации. Реальные production provisioning, удаление, deploy и Store publishing в эти задачи не входят: порядок отдельного rollout — в design.md и Workflow follow-up. Не изменять текущий production новым контрактом и не возобновлять соседний `prepare-public-release` автоматически.

## 1. Контракты поколений и конфигурация

- [x] 1.1 Определить строгие схемы инвентаря/release descriptor, generation ID, версии и public registry с active/retired; добавить unit-проверки дубликатов, числового сравнения 0.9.0/0.10.0, времён, неизвестной схемы и запрета повторного использования retired. В development docs объяснить разницу releaseVersion/backendGeneration/createdWithVersion.
- [x] 1.2 Разделить backend и control настройки в `settings.ts`, `config.ts`, WXT define и release validation; встроить одно поддерживаемое поколение. Unit/release fixtures подтверждают отказ при подмене роли/project ID/database origin, отдельный production control origin и отсутствие production endpoints в QA/emulator build.
- [x] 1.3 Добавить ограниченный reader реестра без Auth/RTDB: 3 секунды, singleflight, интервал 30 секунд, cache до 60 секунд, no-store/no-referrer/omit/redirect error, отмена. Unit-тесты подтверждают unknown при ошибке/старом cache, валидность постоянной retired-отметки без ежедневного TTL и отсутствие выбора backend из ответа.
- [x] 1.4 Добавить описание legacy-поколения текущего production в локальный инвентарь и fixtures новых поколений без объявления несуществующих проектов созданными. Проверка отличает сведения runbook от подтверждённого live-состояния; зафиксированные QA/control IDs не могут стать кандидатами production-ротации.

## 2. Комната, Rules и локальное состояние

- [x] 2.1 Добавить неизменяемые `createdWithVersion` и `backendGeneration` в metadata, создание и read validation; unit-тесты подтверждают отказ от отсутствующих/чужих полей, приём совместимых версий одного поколения и сохранение metadata при смене видео/reconnect.
- [x] 2.2 Генерировать Rules с точным поколением и сохранять контракт по поколению; integration-тесты настоящих Auth/Rules на эмуляторах проверяют создание своего поколения, отказ чужому, неизменность metadata и прежние ограничения playback/presence/перечисления. Документировать генерацию, не публикуя Rules в production.
- [x] 2.3 Включить поколение и версию локального формата в namespaces каталога/bindings и room-bearing сообщения; unit/browser проверки подтверждают сохранение каталога при совместимом релизе, отсутствие миграции старого namespace и отсутствие коллизии одинакового key у разных поколений.
- [x] 2.4 Защитить восстановление session/background от старых bindings/targets при reload, worker restart и обновлении runtime. Browser-сценарий подтверждает отсутствие старого presence, replay команд, автоматического входа и открытия вкладки поздним сообщением; development docs описывают локальный просмотр после несовместимого обновления.

## 3. Постоянные приглашения и Hosting

- [x] 3.1 Изменить генерацию/парсинг приглашения на точный control origin и fragment generation+room; unit-тесты покрывают дубликаты, чужой origin/path, query, URL credentials, подмену поколения и прежний fragment без generation. Старые origins/форматы не принимаются через fallback.
- [x] 3.2 Обновить invitation bridge, sender checks, manifest/CSP/resources под точный служебный origin без wildcard web.app. Release и browser проверки подтверждают работу extension iframe, отказ посторонним sender/frame и отсутствие remote hosted code; обновить обоснование host permissions в Store docs.
- [x] 3.3 Подготовить постоянную Hosting-страницу и локальный bundled script диагностики по реестру без расширения; browser-тесты active/retired/unknown и privacy проверяют понятные состояния, no-referrer/CSP и отсутствие room key/UID/token в исходящих HTTP и Store-ссылках. Инструкция установки не должна скрывать завершение поддержки.
- [x] 3.4 Разделить подготовку control Hosting и backend output; реестр, privacy, installation state и статусы всех поколений собираются целиком. Fixture-тесты подтверждают сохранение retired и чужих инцидентов, правильные headers и отсутствие Auth/Database в служебном deploy config; команды подготовки описаны в release runbook.

## 4. Вход, ошибки и статусы

- [x] 4.1 Классифицировать своё, чужое active, неизвестное и retired поколение до сетевого входа; добавить единые сообщения для invitation/popup/session. Unit/browser проверки подтверждают отсутствие чужого Auth/REST/realtime, отсутствие retry для несовместимости/retired и только явное создание новой комнаты. Для retired собственного поколения прямое создание в popup блокируется до Auth/записи и сначала предлагается обновление расширения.
- [x] 4.2 Для своего поколения сохранить локальную активацию вкладки перед сетью; включить реестр и generation-status в прежний общий бюджет 15 секунд. Проверки зависших ответов/отмены подтверждают один владелец попытки, отсутствие позднего открытия и сохранение 10/20/40/60 retry с jitter и четырьмя повторами.
- [x] 4.3 Перенести status reader и операторскую подготовку на `/generations/<generation>/service-status.json` служебного origin без изменения схемы временного статуса. Тесты подтверждают изоляцию поколений, приоритет retired над operational/busy и прежние 3 секунды/30 секунд/60 секунд/TTL; runbook содержит публикацию и снятие инцидента выбранного поколения.
- [x] 4.4 Проверить runtime-регрессии: здоровый просмотр без polling, unknown реестр не блокирует своё подключение, чужой реестр не меняет базу, stop/retry сохраняют binding и detached. Browser-счётчик подтверждает максимум один realtime socket на watch и ноль у read-only входа; обновить документацию этих границ.

## 5. Подготовка и аудит релиза

- [x] 5.1 Ввести локальную подготовку `new|reuse` по release descriptor с обязательной предыдущей версией/поколением и проверяемыми снимками/хэшами контракта. Fixture-тесты подтверждают reuse без нового проекта, отказ new на project ID прежнего поколения и запрет генерации старых Rules из текущего контракта.
- [x] 5.2 Разделить явные backend/control deploy paths и проверять проект/артефакты перед запуском CLI. Тестовый адаптер фиксирует только выбранные project ID и `--only` ресурсы, отсутствие вызовов облака из build/audit/prepare и отсутствие обращения к другим production поколениям; release runbook содержит точные границы операций.
- [x] 5.3 Обновить release ZIP/audit/build-info под generation/backend/control mapping и точные manifest permissions/CSP; позитивные и негативные package fixtures проходят, ошибки не оставляют ready ZIP. Проверка выполняется на изолированной конфигурации без изменения рабочего `.env.production`; fixture-пакет не объявляется готовым production-релизом.
- [x] 5.4 Уточнить privacy, Store disclosures, PRD, development docs и ADR по фактической реализации: отсутствие межпоколенной совместимости, срок жизни до отключения backend, постоянные новые ссылки и предел legacy-ссылок. Сверка не обещает доступность старой комнаты после обновления и не отмечает Store/production rollout выполненными.

## 6. Операторский план и ротация

- [x] 6.1 Реализовать проверяемый локальный план ротации с generation/project ID, firstRelease, ролями, состояниями и результатами этапов; unit-тесты выбирают старейший первый релиз численно, учитывают provisioned кандидата, исключают QA/control и блокируют противоречащий фактический инвентарь. Описать лимит работающих backend отдельно от облачной квоты.
- [x] 6.2 Реализовать последовательность publish+verify retired → delete exact project+verify → quota/preflight → provision, с продолжением того же плана. Интеграция с fake cloud adapter доказывает порядок, отсутствие четвёртого работающего backend и отсутствие удаления при свободном месте; настоящие проекты для проверки не удаляются.
- [x] 6.3 Добавить проверки ошибок и повторов: публикация, 403 удаления, неизвестный исход, DELETE_REQUESTED с занятой квотой, сбой создания после удаления, повтор/параллельный запуск одного плана, изменившаяся revision реестра и ручное восстановление проекта. Тесты доказывают остановку на проблемном этапе, локальную сериализацию, отсутствие второй жертвы/дубликата и вывод причины без credentials.
- [x] 6.4 Подготовить release runbook для первого rollout и дальнейшей ротации: точные проекты/квота/артефакты, проверка публичной revision, подтверждение удаления, ограничения 30-дневного окна и откат control без возврата retired в active. Прогон на fixtures воспроизводит команды/план; реальный provisioning, deletion и Store действия остаются отдельными.

## 7. Сквозная проверка и передача

- [x] 7.1 Выполнить локальную browser/integration матрицу двух поколений и двух профилей: вход/общая команда в своём, совместимый patch, оба направления несовместимого приглашения, retired при неработающем backend, unknown registry, cancel/reload/update и socket budget. Обезличенный отчёт различает настоящий эмулятор/Rules, HTTP fixtures и live-наблюдения.
- [x] 7.2 Выполнить отдельный live QA smoke на реальном YouTube с новым форматом комнаты/приглашения и тестовым control Hosting; подтвердить Auth/REST/CSP, одну revision без эха, stop/retry и отсутствие production запросов. При отсутствии доступа или незавершённом smoke оставить задачу открытой с причиной; локальная матрица не заменяет live результат.
- [x] 7.3 Выполнить typecheck, unit/release tests, emulator integration и целевые browser regressions, обычную/QA/изолированную release-сборку, strict OpenSpec validation и diff check. В verification.md сохранить команды, exit codes, skipped, generation/config provenance и ограничения; не считать проверкой нового production артефакты 0.2.0.

## Workflow follow-up

- После реализации провести review и синхронизацию specs, затем архивировать только при выполненных обязательных проверках; открытые live-эксперименты не закрывать предположением.
- Отдельный rollout: сверить актуальный Store/prepare-public-release, создать постоянный служебный Firebase-проект и новый backend, опубликовать control и только новый backend, собрать настоящий release ZIP и пройти smoke. На первом rollout legacy не удаляется: лимит ещё не достигнут.
- Загрузка в существующую карточку Chrome Web Store, review, Publish и установка из Store — отдельные явно выполняемые этапы. Не представлять draft/review или backend-ready как завершённый выпуск.
- 2026-11-04 пользователь возобновил работу после паузы на 2.4. Выполнены 27 задач. Проверки и границы QA описаны в verification.md.
