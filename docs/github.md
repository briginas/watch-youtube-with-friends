# Публикация исходников

## Проверки

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run spec:validate
npm run repo:audit
npm run repo:audit -- --ref main
```

`repo:audit` без аргументов проверяет отслеживаемые и неигнорируемые новые файлы
рабочего дерева. `--ref main` проверяет все версии файлов и metadata коммитов,
достижимых из main, включая содержимое gzip. Вывод содержит только категории и пути.
Это проверка известных форматов, не доказательство отсутствия любого возможного секрета;
перед первой публикацией дополнительно используется Gitleaks.

CI проверяет историю HEAD, typecheck, unit-тесты, сборку, browser smoke, Emulator Suite
и OpenSpec. Cloud credentials, live YouTube и deploy в CI не используются.

## Первая публикация

Подготовленная main начинается с одного корневого коммита. Оригинальная история
сохранена только локально в `codex/original-before-github-2026-11-05`.
Не отправляйте эту ветку, refs/codex и локальные резервные копии. Не используйте
`git push --all` или `git push --mirror` и не объединяйте старую ветку с новой main.
На исходной машине установлен локальный pre-push guard: он блокирует отправку
старой истории, в том числе под новым именем ветки. Guard не переносится при clone.

Репозиторий проекта: https://github.com/briginas/watch-youtube-with-friends.
Для первоначальной загрузки добавьте remote и отправьте только main:

```sh
git remote add origin https://github.com/briginas/watch-youtube-with-friends.git
git push -u origin main
```

Перед выполнением убедитесь, что проверяется именно эта ветка и выбранная публичность
репозитория соответствует намерению. Авторский email сохранён по явному решению владельца;
его присутствие в metadata коммита допустимо. Операторские email в документах удалены.

Проект распространяется по [MIT License](../LICENSE). Загрузка исходников на GitHub
не меняет Chrome Web Store или Firebase. Исторические отчёты обезличены, их старые commit IDs и
package hashes не подтверждают содержимое новой main; полные оригиналы остаются локально.
