# Verification — 2026-11-06

## Причина и воспроизведение

До исправления новый Chromium-тест с настоящим action popup не дождался подключения за 15 секунд после `history.pushState` с главной YouTube на watch. Popup оставался в «Подключаемся…»; background проверял watch в `sender.url` и отклонял attach.

После исправления тест подтверждает значения настоящих Chrome MessageSender: `sender.url` равен исходной главной/поиску, `sender.tab.url` равен текущему watch. Проверка источника осталась отдельной от проверки текущей страницы.

## Автоматические проверки

- `npm run typecheck` — успешно, включая новые браузерные тесты.
- `npm test` — 306 tests, 38 files, успешно.
- `npm run build:transport` — успешно.
- `node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together 'npx playwright test --config playwright.transport.config.ts session-start.spec.ts lifecycle.spec.ts creation.spec.ts video-switch.spec.ts'` — 23 passed, 3 opt-in live skipped.
- Новый regression: главная → watch, поиск → watch, прямой watch в трёх отдельных вкладках одного профиля; до перехода popup не запускает session; после перехода подключение и создание комнаты успешны; повторное открытие использует тот же единственный iframe. Прежние вкладки остаются открытыми.
- Существующие сценарии подтвердили Auth retry, reload, остановку worker, создание/clipboard, offline и ограничения плеера, смену видео, гонки маршрутов и stale target.

## Настоящий YouTube

`YOUTUBE_TRANSPORT_REAL=1 node scripts/firebase.mjs emulators:exec --only auth,database,hosting --project demo-watch-together 'npx playwright test --config playwright.transport.config.ts youtube-session-start.spec.ts --output=/tmp/session-start-live-results'` — 1 passed (13.0 s).

В двух новых вкладках Chromium 156 выполнен клик по настоящему результату поиска YouTube. Сохранённая метка DOM подтвердила переход без перезагрузки документа; в обеих вкладках настоящий popup показал подключение, кнопка «Смотреть вместе» стала активной и появился ровно один session iframe. `history.pushState` и ответы YouTube в этой проверке не подменялись. Backend — локальный Firebase; доступность production-сервера, естественная реклама и синхронизация двух участников этим тестом не проверяются.

## Сборка

Версия package и lock: 0.2.7. `npm run release:prepare -- reuse 0.2.6 prod-v1` подготовил локальный descriptor `.local/deployment/generations/releases/0.2.7.json`; это локальная конфигурация оператора, исключённая из Git по правилам репозитория. Backend-контракт не менялся.

`npm run release:build` с `.env.production` завершился успешно, включая аудит 20 файлов и ZIP. Каталог для Chrome: `.output/release/chrome-mv3`; пакет: `.output/release/watch-together-0.2.7.zip`. Deploy и публикация в Store не выполнялись.
