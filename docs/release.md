> Публичная копия: сведения оператора обезличены; example IDs и контакты не являются действующей конфигурацией. Исторические результаты не подтверждают текущее состояние сервера.

# Публичный выпуск

Издатель: **briginas**. Developer account Chrome Web Store: `operator@example.invalid`.
Публичный Contact email address и поддержка: `support@example.invalid` (подтверждено владельцем 2026-11-04).

Сначала настройте локальные файлы по [инструкции конфигурации](configuration.md).
Ниже приведены обезличенные исторические записи и процедура выпуска.

## Сборка и аудит

Node 24.12+ из ветки 24, `npm ci`. Скопировать `.env.production.example` в локальный
`.env.production` и заполнить публичные Firebase-параметры backend и control и `RELEASE_FIREBASE_PROJECT_ID`.
Этот файл исключён из Git. Service account, OAuth credentials, room secrets и токены туда не нужны.
Для воспроизведения иконок: `npm run icons:build`; исходник — `assets/icon.svg`.

```sh
npm run release:build
npm run release:audit
npm run release:prepare-control
```

`release:build` сначала удаляет `.output/release`, собирает production и создаёт
`.output/release/watch-together-<version>.zip` с `manifest.json` в корне. Рядом — `.sha256`,
`.audit.json` и `build-info.json`. Версия берётся из `package.json`.
`release:audit` повторно упаковывает проверенный output; после изменения исходников нужен
именно `release:build`. При ошибке готовый ZIP и его отчёты удаляются.

Launcher не использует `.env.cloud`: это отдельное QA-окружение. Он запрещает QA/demo/test,
неполные/конфликтующие параметры, probes, emulator-флаги и посторонние WXT/Vite-поля
в автоматически читаемых env-файлах. Release output отделён от обычного и QA output.
Обычные `build` и `build:transport` используют собственные режимы. Runtime-конфигурация
фиксируется по выбранному режиму до автоматического чтения WXT env-файлов; обычный build
без настроек сервера не подключается к production. Для QA используйте `build:cloud`,
который явно передаёт `.env.cloud`.

ZIP создаётся из разрешённых типов файлов, распаковывается во временный каталог и проверяется
повторно. Проверяются manifest/CSP/resources, PNG-размеры, пути, symlink, maps, известные
форматы credentials, private env-значения и известные статические fixture-ключи.
Ошибки показывают только категории находок. API key Firebase — публичная конфигурация;
сам ключ в отчёт не выводится. Аудит не доказывает отсутствие любого неизвестного формата
секрета и не проверяет runtime IndexedDB/storage. При использовании расширения там появляются
Anonymous Auth-токены и секреты комнат; их нельзя добавлять к release-материалам.

## Отключение legacy

2026-11-06 пользователь подтвердил, что legacy больше не используется. Её env и
снимки удалены из рабочего deployment и примеров; история начинается с prod-v1
0.2.1 с явным `previous: null`. Исторические доказательства первого выпуска
сохранены в `docs/release-evidence.json` и OpenSpec archive.

2026-11-06 публичная карточка Store уже ссылается на privacy на control Hosting
(HTTPS 200, CSP, no-referrer, nosniff проверены). После повторной сверки project ID,
номера проекта, ролей и текущих descriptors запрошено удаление только legacy.
Google Cloud подтвердил `DELETE_REQUESTED` в 13:07:46 UTC. QA, control и prod-v1
повторно проверены: все `ACTIVE`. Локальный инвентарь хранит legacy как
`delete-requested` с live provenance; исторические доказательства сохранены.
Это подтверждение принятого запроса, не окончательного удаления: Google выполняет
его асинхронно. [Журнал завершения](../openspec/changes/archive/2026-11-06-remove-legacy-deployment/verification.md).

## Chrome Web Store

Тексты карточки и disclosures — `docs/store-listing.md`. Загрузить только ZIP с сохранённым
SHA-256. Реальные screenshots должны быть сняты с release-сборки; UID, room secrets и
токены не должны попадать в изображения. Подать на review с deferred publishing.
Draft/review не означают публикацию.

Item ID: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
Dashboard и ID operator account хранятся только в локальном журнале.
Публичная карточка подтверждает версию 0.2.6 (2026-11-06). Исторические сведения о
ZIP 0.1.0 сохранены в `docs/release-evidence.json`. Публичная privacy-ссылка уже
переключена на control Hosting. На 0.2.6 проверены установка из Store в двух
независимых Chrome profiles, возврат к приглашению после установки, вход второго
участника и play/pause между профилями. Исходный ZIP 0.2.6 связан с commit `4ad0b28`,
SHA-256 `9119f7b581f659ec465759fdaef30197a8b1df8a7ae6c79e9fd699bcbb2dc438`.
Полный журнал — [verification](../openspec/changes/archive/2026-11-06-prepare-public-release/verification.md).

После фактической публикации проверить публичную карточку, записать ID в `RELEASE_STORE_ID`
и установить `RELEASE_STORE_PUBLISHED=1` в локальном env. Выполнить `release:prepare-control`, проверить
ссылку и выполнить `release:deploy-control` для нового control-проекта. До этого страница честно сообщает об ожидании публикации.
Этот переход выполнен 2026-11-06: опубликован control Hosting с рабочей Store-ссылкой,
без сообщения об ожидании; публичный реестр поколений не изменился. HTTPS 200,
CSP, no-referrer и nosniff подтверждены. Backend повторно не разворачивался.
Ссылка в Store и privacy находятся вне секрета fragment; privacy остаётся доступна при скрытии
`#installation` и не подключает invitation iframe.

## Черновик обновления 0.2.7 — 2026-11-06

Пакет 0.2.7 загружен в Chrome Web Store и сохранён: раздел Package подтверждает
`Draft 0.2.7` и `Published 0.2.6`. На review обновление не отправлялось.
Изменение исправляет начало watch-сессии после SPA-перехода YouTube;
[OpenSpec change](../openspec/changes/archive/2026-11-06-fix-spa-session-start/verification.md)
уже проверен, синхронизирован и архивирован. Версия была повышена в этом change;
при подготовке Store-пакета повторно не менялась.

Сборка из чистого дерева commit `437e9ec` на Node 24.19.0 после `npm ci`:

- ZIP: `.output/release/watch-together-0.2.7.zip`, 20 файлов.
- SHA-256: `5e1d4619b1a70ff2bbcb2ac74e6893ce9da94de5e05f79df52bdf7ccc7a04238`.
- Descriptor: `.local/deployment/generations/releases/0.2.7.json`,
  `reuse 0.2.6 prod-v1`; прежние Rules/schema и backend сохранены.
- `release:build`, повторный `release:audit`, `release:prepare-control` — успешно.
  Deploy backend/control не выполнялся.
- Typecheck, 306 unit-тестов, 7 спецификаций и аудит 503 файлов репозитория — успешно,
  аудит без находок.
- Два E2E-теста загрузки расширения/метки сборки и два browser-теста Hosting — успешно.
  Первый запуск Chromium в sandbox завершился до тестов (`SIGABRT`/`EPERM`);
  повторный запуск вне sandbox прошёл.

Разрешения и интерфейс не менялись; описание, privacy disclosures и снимки Store
сохранены. Проверки настоящего YouTube для SPA-исправления приведены в архиве change;
новая проверка двух production-профилей в этой подготовке не выполнялась.
Каталог для ручной установки: `.output/release/chrome-mv3`.
Следующий этап — отправка на review с deferred publishing, затем отдельная публикация.

## Эксплуатационные ограничения

Комнаты не имеют TTL и автоматического удаления. Удаление из каталога локальное; выход не
удаляет серверную комнату. Участники с полным ключом и Anonymous Auth могут читать комнату
и отправлять общие команды; членство и приглашения с истечением срока не реализованы.
Обращения о данных принимает `support@example.invalid`; технический владелец проекта — аккаунт
Firebase `support@example.invalid`. При отказе quota проверить Firebase Console → Usage,
Auth и RTDB → Usage; остановить распространение, выяснить источник роста, при необходимости
временно запретить новые записи правилами. Это остановит работу клиентов. Биллинг автоматически
не подключать. Восстановление — после проверки квот/Rules и повторного smoke.
Резервное копирование/автоматическое восстановление сейчас не настроены.

App Check enforcement не включать без проверенного поддерживаемого release-клиента.
Анонимный вход и секретный ключ не обеспечивают серверное ограничение числа создаваемых комнат.
Проверка двух profiles на одном компьютере не заменяет проверку в независимых сетях.

API key ограничен API `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`,
`firebasedatabase.googleapis.com`. Browser referrer restrictions не установлены:
работа extension Auth подтверждена именно с этой конфигурацией. Ключ публичный;
авторизацию данных выполняют Auth и Rules.

Фактические effective quotas прочитаны через Service Usage v1beta1:
Identity Toolkit Queries — 30 000/min/user и 180 000/min/project;
Secure Token — 6 000 token exchange requests/min/project и 18 000 token exchanges/min/project.
Это не снимает прочие ограничения Auth и лимиты Spark. RTDB Spark ограничивает число
одновременных подключений до 100; следить за Usage до расширения аудитории.
Документация: https://firebase.google.com/docs/database/usage/limits

App Check API вернул пустой список настроенных services. В коде нет App Check SDK/provider;
production Auth/RTDB smoke работает без App Check. Web reCAPTCHA Enterprise требует
регистрации приложения, provider, допустимых доменов и интеграции клиента; для этого
расширения пригодность ещё не подтверждена. Enforcement не включён.
Документация: https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider

Наблюдение: `https://console.firebase.google.com/project/<backend-project>/usage`
и `https://console.cloud.google.com/apis/dashboard?project=<backend-project>`.
Используйте project ID активного поколения из локального инвентаря.
Проверять Auth signup/ошибки, RTDB connections/storage/download и квоты указанных API.
Ответственный за реакцию — briginas, `support@example.invalid`.

## Подготовка поколений

Подготовленная версия 0.2.7 использует поколение `prod-v1`, начавшееся с версии 0.2.1.
Backend `example-production-backend` использует Anonymous Auth и RTDB в `europe-west1`.
Страница приглашения, политика конфиденциальности и реестр опубликованы на
`https://example-control.web.app/`. На обоих проектах отключён биллинг.
Текущая конфигурация сохранена локально в `.env.production`.

Для установки откройте `chrome://extensions`, включите режим разработчика и выберите
«Загрузить распакованное расширение». Укажите каталог `.output/release/chrome-mv3`.
Участники, которым передаётся ZIP, сначала распаковывают его и выбирают каталог с `manifest.json`.

Укажите фактические роли и project ID в `.local/deployment/generations/inventory.json`.
Новый backend получает новый ID, первое поколение нового формата и собственный Auth/RTDB.
Control получает постоянный отдельный Firebase project с Hosting. QA остаётся отдельным
стендом. Перед заведением кандидата сверить доступную квоту Google Cloud и фактические
проекты. Старые проекты учитываются до подтверждения их удаления.

Выберите версию пакета. Только для нового развёртывания без release descriptors
используйте `initial`: он создаёт descriptor нового поколения с `previous: null`.
Версия пакета должна совпадать с firstRelease в инвентаре. Не используйте initial
поверх примера или существующей истории.

```sh
npm run release:prepare -- initial
npm run release:prepare-backend
npm run release:prepare-control
npm run release:build
npm run release:audit
```

Для следующего несовместимого поколения используйте
`release:prepare -- new <previousVersion> <previousGeneration>` с настоящим
предыдущим descriptor. `initial` и `new` сохраняют Rules и schema по поколению
и записывают descriptor версии с хэшами.
Для следующего совместимого пакета используйте `release:prepare -- reuse <previousVersion> <generation>`.
Инвентарь должен подтверждать active backend, а предыдущий descriptor должен ссылаться
на те же снимки. `reuse` не развёртывает новый контракт. Build и audit сверяют descriptor
с env и снимками, а отчёты указывают версию, поколение и оба project ID.

После отдельного разрешения на rollout backend публикуется командой
`npm run release:deploy-backend` с `--only database,auth` в provisioned backend project.
Инвентарь должен содержать подтверждённое наблюдение этого проекта с provenance `live`.
Проведите backend smoke до добавления active в `.local/deployment/control/backend-generations.json`.
Добавьте статус поколения. Проверьте Hosting output, включая privacy и Store-ссылку,
и отдельно опубликуйте `npm run release:deploy-control` с `--only hosting`.
Для первого пустого сайта нужен явный `--initial-control` и ответ 404 на запрос реестра.
После публикации запросите `/backend-generations.json` с `Cache-Control: no-cache`,
сверьте revision и содержимое, затем проверьте страницу приглашения без расширения.
Store upload, review и Publish выполняются отдельно.

## Статус поколения

Объявления хранятся в `.local/deployment/control/generations/<generation>/service-status.json`.
Команда обновляет только статус указанного поколения. TTL составляет от 1 до 86400
секунд, busy retry от 10 до 300 секунд. Просроченное объявление считается неизвестным.

```sh
npm run status:prepare -- <generation> busy - 3600 60
npm run status:prepare -- <generation> unavailable quota 3600
npm run status:prepare -- <generation> operational - 3600
npm run release:prepare-control -- /path/to/previous-registry.json
npm run status:deploy
```

Выберите одно объявление. Последняя команда заново собирает и публикует весь control
Hosting. Сверьте JSON выбранного поколения, прежние инциденты, retired и заголовки
`Cache-Control: no-store` и `Content-Type: application/json`. Для снятия инцидента
подготовьте operational и опубликуйте тем же способом. Уже подключённый исправный
просмотр работает без опроса статуса.

## Ротация и восстановление после сбоя

Лимит в три работающих backend включает provisioned проекты. Квота Google Cloud
учитывается отдельно. DELETE_REQUESTED освобождает место в лимите работающих backend,
но может занимать облачную квоту до 30 дней. ID удалённого проекта не переиспользуется.

План хранит точные project ID и generation кандидата и жертвы, первый релиз, снимки
публичного реестра и завершённые этапы.

```sh
node scripts/rotation.mjs plan <generation> <registry.json> <observed.json>
npm test -- tests/release/rotation.test.mjs
```

В `observed.json` передайте массив фактически сверенных записей с projectId, role,
generation для backend и состоянием ACTIVE, NOT_FOUND, DELETE_REQUESTED или DELETED.
Сохраните журнал `.output/rotation/plan.json` на весь цикл. Для повторного запуска
используйте `node scripts/rotation.mjs resume <adapter.mjs>` с тем же журналом.
В этот change входит тестовый адаптер. Реальный адаптер подключается отдельно при
rollout. Он экспортирует default object с методами `observe(projectIds)`,
`readRegistry(controlProjectId)`, `quota(candidateProjectId)`,
`publish(controlProjectId, registry, expectedRevision)`, `deleteProject(projectId)`
и `provision(projectId, generation, planId)`. `quota` возвращает `{ canCreate }`,
а `observe` подтверждает `planId` кандидата, созданного этой операцией.
После сверки завершённого плана и обновления инвентаря перенесите журнал в архив.

1. Сверьте проект и роли по фактическому инвентарю. При трёх backend план выбирает
   старейший первый релиз по числовой версии. QA и control исключаются.
2. Проверьте квоту, опубликуйте retired и проверьте точную публичную revision и снимок.
3. Запросите удаление указанного project ID, затем подтвердите DELETE_REQUESTED или
   окончательное удаление у провайдера. При неопределённом результате остановитесь.
4. Повторно проверьте квоту и создайте только указанного кандидата. При сбое или
   занятой квоте продолжите тот же файл плана. Перед повтором сверяется, создал ли
   его этот план. При восстановлении жертвы или посторонней revision разберите
   расхождение перед дальнейшими действиями. Освободившееся место подтверждается
   наблюдением. Дополнительную жертву этот план не выбирает.
5. Запишите подтверждённое provisioned в инвентаре. Разверните контракт, выполните
   smoke и опубликуйте active после проверки backend.

При свободном месте этапы публикации retired и удаления пропускаются. Для отката
control соберите нужные файлы с актуальной историей retired и статусами. Если реестр
изменяется, задайте следующую revision. Прямая публикация старой Hosting-версии может
стереть отметки retired и нарушить историю поколений.
