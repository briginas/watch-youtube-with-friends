# Проверка compact-popup-header

Дата: 2026-11-11.

- `npm run typecheck` — успешно.
- `npm test` — 326 тестов, 40 файлов, успешно.
- `npm run release:build` — успешно, настройки `.env.production`, версия 0.2.8, 24 файла; сборка и аудит ZIP прошли. Пакет и версия не повышались, публикация не выполнялась.
- `npm run build` — успешно, отдельная dev-сборка для smoke.
- `npx playwright test --config playwright.release.config.ts popup-ui.spec.ts localization.spec.ts` — 8 тестов успешно: клавиатура, сохранение/повторное открытие, ошибки storage, геометрия и контраст, прокрутка, локали ru/ru-RU/en/de.
- `npx playwright test` — 2 smoke-теста успешно: загрузка MV3, popup вне YouTube, переключение темы и метка сборки Chrome.
- Delta синхронизирована в `popup-appearance`, change архивирован; `npm run spec:validate` — все 10 спецификаций успешно. `git diff --check` — успешно.

Chromium в sandbox завершался до тестов с SIGABRT/EPERM. Указанные успешные browser-прогоны выполнены вне sandbox с временными профилями. Комнатные данные в popup-ui/localization — fixture; внешние запросы прерваны. Это проверка настоящего React/CSS/storage/i18n расширения, не подтверждение синхронизации с настоящим YouTube.

Скриншоты `screenshots/{light,dark}-{400,336}.png` сохранены с release-сборки. Визуально просмотрены light-400 и dark-336: верхняя строка отсутствует, подложки читаемы, версия и переключатель не перекрываются. В светлой теме при 400 px popup короче прежней компоновки на 64 px.

Для ручной установки с рабочим сервером: `.output/release/chrome-mv3`.
