> Публичная копия: сведения оператора обезличены; example IDs и контакты не являются действующей конфигурацией. Исторические результаты не подтверждают текущее состояние сервера.

# Chrome Web Store — подготовленные поля

Опубликованная версия: 0.2.6 (проверено 2026-11-06). Издатель: **briginas**. Developer account: `operator@example.invalid`.
Публичный контакт: `support@example.invalid`.
Privacy URL: `https://<control-project>.web.app/privacy.html` — постоянный control
Hosting. Страница проверена: HTTPS 200, CSP, no-referrer и nosniff. Публичная
карточка подтверждена с новым URL 2026-11-06. После проверки Google Cloud принял
удаление старого legacy-проекта (`DELETE_REQUESTED`); control Hosting остаётся
`ACTIVE`. Пакет 0.2.6 повторно не загружался.

Обновление 0.2.7 загружено и сохранено в draft 2026-11-06: исправлен запуск
совместного просмотра после перехода на видео внутри YouTube. Раздел Package
подтверждает `Draft 0.2.7` и `Published 0.2.6`. Описание, снимки и disclosures
сохранены без изменений. На review обновление не отправлялось.
SHA-256 и проверки пакета приведены в [журнале выпуска](release.md#черновик-обновления-027--2026-11-06).

## Название и описание

**Watch YouTube with friends**

Краткое описание: **Совместный просмотр видео на YouTube.**

Подробное описание:

> Смотрите YouTube вместе с друзьями в Chrome на компьютере.
>
> Откройте видео YouTube, нажмите значок расширения и «Смотреть вместе». Передайте приглашение друзьям с установленным расширением. Любой участник может включать и останавливать видео, перематывать, менять скорость и выбирать новое видео для комнаты.
>
> Компактная панель на странице YouTube показывает состояние комнаты и участников. В popup доступны приглашение и список «Мои комнаты»: можно вернуться к просмотру или открыть сохранённую комнату. Переход на другой ролик остаётся личным, пока вы явно не выберете «Смотреть это в комнате».
>
> Громкость, качество и субтитры каждый настраивает для себя. Реклама, буферизация и ограничения автозапуска обрабатываются локально; иногда нужно один раз запустить видео вручную. При потере связи просмотр остаётся локальным, а попытки подключения можно остановить и повторить позже.
>
> Регистрация не нужна: для подключения используется анонимная аутентификация Firebase. Для совместного просмотра нужны интернет, доступ к YouTube и Firebase и совместимые версии расширения у участников. Приглашение даёт доступ к комнате — делитесь ссылкой только с нужными людьми.
>
> Удаление комнаты из списка удаляет только локальную запись. Серверные комнаты пока не имеют автоматического срока удаления. Подробнее — в политике конфиденциальности.
>
> Открытый исходный код, лицензия MIT:
> https://github.com/briginas/watch-youtube-with-friends
>
> Поддержка: support@example.invalid.
> Расширение не связано с Google или YouTube и не одобрено ими.

Категория в dashboard: Entertainment. Язык: русский.
Распространение: Free of charge, Public, All regions.
Item ID: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
Homepage URL: https://github.com/briginas/watch-youtube-with-friends
Support URL: https://github.com/briginas/watch-youtube-with-friends/issues

Обновление карточки 0.2.6 сохранено в draft: описание, ссылки на исходники и поддержку,
два новых снимка release-интерфейса. Отправка на review и публикация — отдельные этапы.

## Single purpose

Synchronize playback of a YouTube video between people who explicitly join the same watch room.

## Обоснования разрешений (English для dashboard)

- **activeTab**: Identify the YouTube watch tab when the user opens the extension action,
  so the popup can create or reopen the room for that tab.
- **clipboardWrite**: Copy the room invitation only after the user clicks the copy button.
  The extension does not read the clipboard.
- **storage**: Save the room list and local viewing preferences within the Chrome profile,
  and retain room-to-tab bindings during the browser session.
- **https://www.youtube.com/* and https://youtube.com/***: Embed the local extension room panel
  and synchronize the YouTube player's video ID, position, playback state and speed.
  The extension reads the video title to name a room.
- **Exact HTTPS origin of control Hosting**. Recognize invitations on the dedicated
  invitation page and present the bundled extension join interface. Also fetch the public
  generation registry and generation-specific service status without credentials, room secrets or referrer. The bridge only activates
  at the exact configured root path; the privacy page does not open a room or authenticate.
- **Remote code**: No. All executable extension code, including Firebase SDK, is bundled.
  Network responses supply authentication, room data and a public service status; they are not executed as code.

## Privacy disclosures

Раскрывать данные консервативно по фактической реализации:

- **Personally identifiable information**: технический анонимный Firebase UID; имя и email не запрашиваются.
- **Location**: только IP/сетевые метаданные, получаемые Firebase при запросах;
  dashboard прямо относит IP к Location. GPS/точная геолокация не запрашиваются.
- **Authentication information**: Anonymous UID and Firebase access/refresh tokens. Tokens
  are generated at runtime and stored in the extension's IndexedDB for session persistence.
- **Web history**: YouTube video identifiers watched in a room, retained in room state and
  the user's local room list. General browser history is not collected.
- **Website content**: YouTube video title used as the room name and video playback metadata.
- **User activity**: Play/pause, seek, speed and video changes, command times and room presence,
  only as required for shared playback.
- **Personal communications**: No chat or message content is collected by the extension.
- No names/emails, health, financial, precise location or payment information are requested.
  Google Firebase receives the IP/network metadata needed to serve requests; this is
  described in the public policy. Check the dashboard's current definitions when selecting categories.

Certifications: data is not sold or transferred for advertising, unrelated purposes or
creditworthiness/lending decisions. No analytics SDK is present.

## Test instructions

No reviewer login or test credentials are needed. Use two independent desktop Chrome profiles,
install the extension in both, and open an ordinary available YouTube video in the first.
Open the extension action, choose «Смотреть вместе», then copy the invitation into the second
profile. On the invitation page click «Присоединиться». If autoplay is blocked, play once in
each profile. Check play/pause/seek, the participant count, creator exit and reopening via
«Мои комнаты». The invitation URL is generated during the test; no permanent test-room secret
is provided. Both profiles require access to YouTube and Firebase WebSocket/Auth endpoints.

Natural ads and independent-network performance have not been accepted for this release.
Do not describe them as verified. Screenshots must come from the actual release UI without
invitation secrets, UID, tokens or developer diagnostics.

## Подготовка обновления 0.2.0

REST GET комнаты передаёт Firebase ID token и ключ только настроенному RTDB origin;
статус Hosting не содержит данных пользователя. Новых permission или категорий
собираемых данных нет; прежние disclosures Auth/network/playback сохраняются.
Подготовка 0.2.0 — исторические сведения; актуальный статус указан в начале документа.

Rooms require a compatible release of the same backend generation. Rooms remain available
while that backend operates. New invitation pages stay on the control site and report
retirement after backend shutdown. Legacy links rely on their original Hosting project.
