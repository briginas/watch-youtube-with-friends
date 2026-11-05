# Материалы Chrome Web Store 0.1.0

`room-1280x800.png` — настоящий YouTube и панель release-версии с двумя участниками,
два изолированных Chromium profiles, production Firebase. Последний снимок создан
headed production smoke 2026-11-04. Viewport без адресной строки; поле приглашения скрыто.
UID, room secret, токены и диагностические панели на изображении отсутствуют.

Размер 1280×800, PNG RGB без alpha. Иконка Store — `public/icon/128.png`, 128×128;
исходник оригинальной иконки — `assets/icon.svg`. Генератор — `scripts/icons.mjs`.
Screenshot в dashboard снят с того же ZIP 0.1.0 во время предыдущего production smoke;
последующий повтор smoke обновляет локальное изображение, но не загруженный ZIP.

Требования к изображениям сверены с официальной документацией:
https://developer.chrome.com/docs/webstore/images
