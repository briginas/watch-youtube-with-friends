# Verification — 2026-11-06

## Локальная реализация

- Typecheck — exit 0.
- Unit — 38 файлов, 306 тестов, все пройдены; покрыты initial/null, запрет повторного initial, new/reuse, отсутствующий/повреждённый предшественник, неизменность снимков и CLI arguments.
- Repo audit — 0 findings; реальные env, IDs и журнал удаления остаются вне Git.
- Strict OpenSpec validation — 8 items passed, 0 failed, включая этот change.
- Release build и audit 0.2.6 — exit 0, ZIP содержит 20 файлов. Сборка подготовлена из `.env.production` в `.output/release/chrome-mv3`; текущий descriptor, project IDs и SHA-256 контракта prod-v1 сверены с сохранёнными значениями.
- Все 6 локальных и 5 example descriptors успешно загружаются без legacy snapshots. Начальный prod-v1/0.2.1 содержит `previous: null`; последующие descriptors сохранены.
- `.env.production.legacy`, оба рабочих набора legacy snapshots и отдельная legacy fixture удалены. Архив OpenSpec и исторические release evidence сохранены.

Новая версия пакета и backend-контракта не выпускалась. Runtime совместного просмотра
не менялся; live YouTube и установка из Store в этой задаче не проверялись.

## Облачное состояние до публикации privacy — история

Публичная карточка Store подтверждает опубликованную версию 0.2.6. Control privacy
возвращает HTTPS 200 с CSP, `no-referrer`, `nosniff`. URL заменён в dashboard и
отправлен на review; UI подтвердил успешную отправку и Pending review.
Автопубликация выключена. Пакет повторно не загружался.

После отправки публичная карточка всё ещё возвращает старый privacy URL. Поэтому
legacy-проект не удалён: его Hosting нужен до публикации новой ссылки. Firebase API
подтвердил все четыре проекта ACTIVE; локальная legacy-запись обновлена с provenance
live и временем наблюдения. Точный целевой ID, защищённые проекты, URL и следующий
шаг записаны в `.local/deployment/legacy-retirement.json` без credentials.

После одобрения: опубликовать изменение URL, проверить публичную карточку и доступность
control privacy, повторно сверить роли, удалить только legacy, проверить состояние
у провайдера и обновить локальный инвентарь. До этого задачи 2.1–2.2 не завершены,
specs остаются delta, change не архивируется.


## Завершение удаления — 2026-11-06

После публикации privacy публичная карточка Store проверена в обычном Chrome:
ссылка указывает на постоянный control Hosting. Повторная HTTP-проверка перед
удалением вернула 200. Пользователь явно поручил выполнить оставшееся удаление.

Перед действием проверены локальный инвентарь, все текущие descriptors, точный
project ID и номер legacy, отдельные роли QA/control/prod-v1. Ни один действующий
descriptor не ссылается на legacy. Google Cloud Resource Manager API перед
операцией подтвердил четыре проекта в состоянии ACTIVE.

Через официальный `projects.delete` отправлен единственный запрос для legacy.
Повторное чтение проектов в 13:07:46 UTC подтвердило:

| Роль | Состояние после операции |
|---|---|
| legacy | DELETE_REQUESTED |
| QA | ACTIVE |
| control Hosting | ACTIVE |
| prod-v1 | ACTIVE |

`DELETE_REQUESTED` — принятие удаления провайдером, не доказательство окончательного
удаления ресурсов. Согласно [Google Cloud API](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/delete),
последующее удаление происходит асинхронно. Backend, Rules, Auth, control Hosting
и пакет расширения повторно не разворачивались. Дополнительные проекты не удалялись.

Локальная запись legacy сохраняется со state `delete-requested`, provenance `live`
и временем наблюдения. Точные ID/номера, результаты до/после и журнал находятся в
`.local/deployment/generations/inventory.json`, `.local/deployment/legacy-retirement.json`,
`.local/deployment/legacy-before-delete.json`, `.local/deployment/legacy-after-delete.json`.
Credentials и пользовательские данные не выводились и не добавлялись в Git.


## Финальные проверки

- Опубликованный descriptor 0.2.6 и текущий 0.2.7 успешно загружены через
  `loadRelease` с обновлённым локальным инвентарём; хэши контрактов совпадают.
- Одно требование с пятью сценариями синхронизировано в `backend-generations`;
  существующие Purpose и требования сохранены. `openspec validate --specs`:
  7 passed, 0 failed.
- После архивации `npm run spec:validate`: 7 passed, 0 failed.
- `npm run repo:audit`: 438 items, 0 findings. `git diff --check`: exit 0.
- Код реализации и пакет в этом завершении не менялись; ранее пройденные
  typecheck/unit/release build проверки приведены выше, повторная сборка не нужна.
