# Решение проблем

Частые проблемы при установке, сборке и запуске. Установка и сборка — в
[INSTALL.md](INSTALL.md); возможности — в [GUIDE.md](GUIDE.md).

**Содержание:**
[🛠️ Сборка из исходников](#сборка-из-исходников) ·
[🍏 macOS](#macos) ·
[🪟 Windows](#windows) ·
[🐧 Linux](#linux)

---

## Сборка из исходников

- **`cargo` или `pnpm` не найдены** (`command not found`) — инструменты стоят в
  нестандартных путях. Откройте новую вкладку терминала (профиль перечитается) или
  выполните в текущей сессии: `source "$HOME/.cargo/env"` ·
  `export PATH="$HOME/Library/pnpm/bin:$PATH"`.
- **`Ignored build scripts: esbuild`** — pnpm блокирует нативные build-скрипты;
  разрешение уже прописано в [pnpm-workspace.yaml](../pnpm-workspace.yaml)
  (`allowBuilds: { esbuild: true }`), достаточно повторить `pnpm install`.
- **Долгая первая сборка Rust** — это нормально: компилируется всё дерево зависимостей
  Tauri. Последующие сборки берут кэш из `src-tauri/target/`.

## macOS

- **Приложение не открывается на другом Mac** («не удаётся проверить разработчика» /
  «программа повреждена») — сборка не подписана Developer ID, поэтому при переносе macOS
  ставит ей карантин Gatekeeper. Запустите хелпер `open-on-mac.sh` (лежит рядом с `.dmg`
  в релизе и при `pnpm tauri:build:mac`) либо снимите карантин вручную:
  `xattr -dr com.apple.quarantine /Applications/vterm.app`. Подробнее — в
  [INSTALL.md](INSTALL.md#готовая-сборка).

## Windows

- **`link.exe` not found** / ошибка линковки — не установлены **C++ Build Tools** или не
  перезапущен терминал после установки.
- **Окно «Не найден Microsoft Edge WebView2 Runtime» / окно не открывается / белый экран** — в
  системе нет **WebView2 Runtime** (бывает на Windows 10 LTSC и необновлённых образах).
  Проще всего взять `vterm-portable-…-x86_64-webview2.exe` — runtime уже внутри, ни сети,
  ни администратора не нужно. Установщики `-setup.exe`/`.msi` ставят его сами (нужен
  интернет); для обычного portable его можно поставить один раз вручную (Bootstrapper или
  офлайн Standalone Installer) — [INSTALL.md](INSTALL.md#webview2-runtime-на-windows).
- **Portable с WebView2: окно «Не удалось подготовить встроенный WebView2 Runtime»** —
  распаковка не удалась, в окне есть причина и папка. Чаще всего это нехватка места на диске:
  runtime занимает сотни МБ в `%LOCALAPPDATA%\vcore\vterm\data\webview2`. Освободите место
  и запустите снова: недоделанная распаковка за готовую не считается, всё начнётся заново.
  Если файл повреждён при копировании («checksum mismatch»), скачайте его заново и сверьте
  `SHA256SUMS`.
- **Portable с WebView2: первый запуск долгий** — так и задумано: окно «Подготовка…»
  означает, что идёт распаковка runtime. Она делается один раз.
- **`winget` не распознан** — в Windows 10 winget приходит с пакетом **App Installer** из
  Store и предустановлен не везде. Поставьте App Installer (через Store или из файлов на
  LTSC), а если он уже стоит — зарегистрируйте его
  (`Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe`)
  и откройте PowerShell заново — [INSTALL.md](INSTALL.md#если-нет-winget). Для **запуска**
  готовой сборки winget не нужен вовсе: он и Rust — только для сборки из исходников.
- **`pnpm` не распознан** — не выполнен `corepack enable` или не перезапущен терминал.
- **`failed to read file 'capabilities\._default.json': stream did not contain valid
  UTF-8`** — исходники скопированы с macOS (флешка FAT/exFAT, сетевая шара, zip), и рядом
  с каждым файлом лёг служебный AppleDouble-двойник `._имя`; Tauri читает **все** файлы
  из `src-tauri\capabilities\` как JSON и падает на нём. Двойники скрытые — `dir` и
  Проводник их не показывают. Удалить из корня репозитория (PowerShell):

  ```powershell
  Get-ChildItem -Path . -Recurse -Force -Filter '._*' | Remove-Item -Force
  ```

  Заодно удалите папки `__MACOSX`. Надёжнее забирать код через `git clone` — тогда
  двойников не будет в принципе, git их не отслеживает.

## Linux

- **«Подключено, но секрет не сохранён в связке ключей: … No default store has been set»** —
  в системе не запущено хранилище паролей Secret Service (GNOME Keyring, KWallet с мостом
  Secret Service, KeePassXC с включённой интеграцией). Так бывает в минимальных оконных
  менеджерах, WSL и headless-сессиях. Подключение при этом работает, просто пароль не
  запоминается, и при следующем подключении его спросят снова. Чтобы пароль сохранялся,
  установите и запустите хранилище (например, `gnome-keyring`) в своей сессии.
- **Вкладка, брошенная на другое окно vterm, открылась в новом окне, а метка не выходит за
  окно** — на Linux vterm не спрашивает оконную систему, какое окно под указателем (на
  Wayland такого ответа нет вовсе), и не угадывает его по положению окон. Перенесите вкладку через ПКМ по ней → «В главное
  окно» / «В окно …» или командой в ⌘K.
