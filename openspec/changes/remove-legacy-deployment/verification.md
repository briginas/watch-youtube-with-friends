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

## Облачное состояние и оставшаяся работа

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
