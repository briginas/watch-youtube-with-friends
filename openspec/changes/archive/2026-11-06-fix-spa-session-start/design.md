# Design

## Context

`watch-session.content.ts` запускается на всех страницах YouTube и читает актуальный `location.href`. Однако background для `room-tab-attach`/`room-tab-restore` требует watch URL в `sender.url`: это URL исходного документа content script, который может оставаться главной страницей после SPA-перехода. Popup уже проверил текущий URL, получает target от content script и опрашивает session, которую background не разрешил смонтировать. Регрессионный Playwright-тест до исправления воспроизводит ожидание до таймаута.

## Goals / Non-Goals

**Goals:** корректно проверять текущий маршрут, сохранив доверенную границу content script/background.

**Non-Goals:** изменение механизма Auth, повторов или внедрение дополнительных iframe/permissions.

## Decisions

- Для attach/restore использовать предоставленный браузером `sender.tab.url` как текущий watch URL; `sender.url` проверять как источник с HTTPS YouTube origin. Сохраняются extension ID, frameId=0 и проверка поколения. URL из тела сообщения не используется. Это локальное исправление существующей проверки, без новых API.
- Для route допускается уход с watch на другую страницу YouTube, как прежде. Полное требование watch для всех сообщений сломало бы detached-режим.
- Проверять настоящий extension popup и background в Chromium с Firebase Emulator Suite: прямой вход, главная/поиск → watch, повторный popup и новая вкладка. Управляемая HTML-страница воспроизводит поведение Chrome при `history.pushState`, но не доказывает поведение реального YouTube. Отдельно проверить реальный SPA-переход YouTube и записать наблюдение.

## Risks / Trade-offs

- Ослабление доверенной границы при замене URL → origin исходного документа проверяется отдельно, чужой extension и дочерний frame по-прежнему отклоняются.
- Навигация во время подключения → content script продолжает проверять `location.href`, а дальнейшие route/player проверки сохраняются.

## Migration Plan

Patch-версия 0.2.7 с прежним backend generation и форматом хранения. Подготовить локальный reuse descriptor от 0.2.6 и production-сборку; публикация в Store и deploy не входят в задачу.

## Readiness

Ready — воспроизведение и код подтверждают локальную причину; новых инфраструктурных решений нет.
