# Локальная конфигурация

Обычная сборка и локальные unit/emulator-тесты не требуют Firebase аккаунта.
Примеры используют вымышленные IDs, а fixtures не связаны с рабочим сервером.

## Файлы

| Назначение | В Git | Только локально |
| --- | --- | --- |
| QA | `.env.example` | `.env.cloud` |
| Production | `.env.production.example` | `.env.production` |
| Инвентарь, release descriptors, Rules snapshots | `config/deployment.example/generations/` | `.local/deployment/generations/` |
| Реестр поколений и статусы | `config/deployment.example/control/` | `.local/deployment/control/` |
| Внутренние отчёты и исходные настройки | не публикуются | `.local/` |

```sh
npm run config:init
```

Команда создаёт отсутствующие env-файлы и, только если каталог deployment отсутствует
целиком, копирует пример. Повторный запуск не перезаписывает настройки и не добавляет
фиктивные поколения в существующее развёртывание. Сам по себе пример не настроен для deploy.

## QA

Создайте собственный отдельный Firebase-проект, Web App, RTDB, Hosting и включите
Anonymous Auth. Запишите публичные параметры Web App в `.env.cloud`.
`CLOUD_FIREBASE_PROJECT_ID`, `WXT_FIREBASE_PROJECT_ID` и `WXT_CONTROL_PROJECT_ID`
должны совпадать; `WXT_BACKEND_GENERATION` начинается с `qa-` (например `qa-v1`).
URL базы и Hosting должны принадлежать выбранному проекту. Production-проект в QA
запрещён. Параметры shell имеют приоритет над `.env.cloud`; противоречащие роли
отклоняются, поэтому очищайте ненужные `WXT_*` и `CLOUD_*` из окружения.

```sh
npm run build:cloud
# Отдельная явная публикация QA; это уже обращение к вашему Firebase:
npm run deploy:cloud
```

Для измерений заполните `CLOUD_FIREBASE_REGION`, `CLOUD_CLIENT_LOCATION`, `CLOUD_NETWORK`.
При пересчёте native-отчётов передайте `CLOUD_FIREBASE_PROJECT_ID` и
`CLOUD_FIREBASE_REGION`; без них отчёт честно указывает `not recorded`.
Пример: `node --env-file=.env.cloud scripts/summarize-native.mjs output.json --raw input.raw.json.gz`.

## Production

1. Заполните `.env.production`: backend и отдельный control project, оба URL,
   API key Web App, поколение, store ID/статус и `RELEASE_SUPPORT_EMAIL`.
2. В `.local/deployment/generations/inventory.json` замените вымышленные IDs на
   свои, укажите роли и фактическое состояние. `provenance: fixture` не является
   подтверждением живого проекта; `live` требует фактической проверки и `observedAt`.
3. Согласуйте всю цепочку descriptors в `releases/` с инвентарём и env. Пример
   иллюстрирует переход `legacy` → `prod-v1` и несколько reuse-релизов; это не история
   вашего сервера. Для существующей установки переносите её собственные descriptors
   и contracts целиком, не заменяйте сохранённые Rules сгенерированными.
4. Настройте `.local/deployment/control/backend-generations.json` и статусы всех
   поколений. Сохраняйте retired-отметки. Свежий статус можно создать через
   `npm run status:prepare -- prod-v1 operational - 3600`.
5. Проверьте `npm run release:build` и `npm run release:prepare-control`.
   Это локальные операции; опубликованное облако не меняется.

Сборщик требует descriptor для текущей версии `package.json`, проверяет всю нужную
цепочку, соответствие project IDs и SHA-256 снимков контрактов. Отсутствующие локальные
файлы не заменяются примерами автоматически. Порядок выпуска и явного deploy —
[в release runbook](release.md).

`RELEASE_SUPPORT_EMAIL` подставляется в страницы приглашения и privacy при подготовке
Hosting. Без него показывается «Контакт поддержки не настроен». Перед публичным deploy
укажите действующий контакт и адаптируйте privacy к вашему размещению (включая регион).
Непосредственный emulator Hosting использует нейтральные исходные страницы.

## Что нельзя помещать в конфигурацию клиента

`WXT_*` попадает в расширение. Здесь допустимы только публичные параметры Firebase,
а не service account, OAuth refresh tokens или секреты комнат. Firebase CLI использует
свою локальную авторизацию. Реальные env, `.local`, output, debug logs и browser profiles
не должны попадать в Git или публикуемые ZIP. `.gitignore` не отменяет ранее добавленный
файл; перед коммитом проверяйте `git diff --cached` и `npm run repo:audit`.

Для перенесённой локальной установки оригинальные документы находятся в
`.local/original-docs/`, исходные env — в `.local/.env.*`. Эти материалы могут содержать
личные данные и служат только локальной резервной копией.
