<div align="center">

# vterm

**Кроссплатформенный SSH-терминал и SFTP-клиент для системных администраторов, DevOps и SRE.**

Графический инструмент в духе [iTerm2](https://iterm2.com/) и
[MobaXterm](https://mobaxterm.mobatek.net/): слева — список серверов, справа — живой
терминал, плюс передача файлов по SFTP, встроенный редактор конфигов, мониторинг и
запись сессий. Написан на **Rust** поверх **Tauri 2** и **SvelteKit**.

![version](https://img.shields.io/badge/version-0.14.0-blue)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-stable-DEA584)
![Svelte](https://img.shields.io/badge/Svelte-5-FF3E00)

</div>

---

## Скриншоты

> 🖼️ _Скриншоты будут добавлены._ Файлы кладутся в [docs/screenshots/](docs/screenshots/);
> разметка уже заготовлена ниже — раскомментируйте по мере появления изображений.

<!--
![Список серверов и терминал](docs/screenshots/servers-terminal.png)
*Двухпанельное окно: дерево серверов и живой терминал.*

![SFTP и редактор конфигов](docs/screenshots/sftp-editor.png)
*SFTP-менеджер и встроенный редактор (CodeMirror) с подсветкой и diff.*

![Мониторинг](docs/screenshots/monitoring.png)
*KPI-дашборд мониторинга: блок «Система», графики, температуры, health-сводка.*

![Запись сессий](docs/screenshots/recording.png)
*Библиотека записей asciicast и встроенный плеер.*
-->

---

## Возможности

- 🔌 **SSH** (russh) по паролю и ключу, с дефолтным ключом из `~/.ssh/`, вкладками,
  локальным терминалом, окном ожидания/ошибки и переподключением.
- 🔐 **Секреты в системном keychain** (macOS Keychain / Windows Credential Manager),
  профили в JSON, проверка отпечатка хоста.
- 📁 **SFTP-менеджер**: обзор, навигация, upload/download, drag-and-drop, прогресс.
- 📝 **Редактор конфигов** (CodeMirror, 50+ языков): правка файлов на сервере и
  локально, diff перед сохранением, линт (локальный и серверный), markdown-превью,
  sudo-правка root-конфигов, синхронизация папок по SHA-256, grep по содержимому.
- 📈 **Мониторинг**: KPI-дашборд (блок «Система», графики ЦП/ОЗУ/сети, температуры,
  SMART/Docker/GPU, health-сводка) + нижний статус-бар с порогами.
- 🔎 **Логи и текст**: поиск по всему буферу, regex-подсветка, структурный
  (табличный) просмотр JSON/logfmt/syslog/nginx/dmesg.
- ⏺️ **Запись сессий** (asciicast v2): библиотека, встроенный плеер, экспорт
  (Markdown-ранбук/команды/транскрипт/`.cast`), автозапись прод-серверов.
- 🎨 **UX**: темы (терминал + UI), командная палитра ⌘K, доступность (a11y),
  i18n (English/Русский), бэкап настроек, полностью офлайн.

📖 **Полное описание возможностей и горячих клавиш — в [docs/GUIDE.md](docs/GUIDE.md)**
(эта же страница встроена в приложение: Help → «Инструкция»).

---

## Быстрый старт

```bash
pnpm install      # JS-зависимости
pnpm tauri dev    # запуск в режиме разработки (первая Rust-сборка ~1–2 мин)
```

Нужны **Node.js 20+**, **pnpm** и **Rust stable** (rustup). Полные требования,
установка на Windows с нуля, сборка дистрибутивов и запуск готового приложения —
в [docs/INSTALL.md](docs/INSTALL.md).

---

## Документация

| Документ | О чём |
|----------|-------|
| [docs/GUIDE.md](docs/GUIDE.md) | Руководство пользователя: возможности, горячие клавиши |
| [docs/INSTALL.md](docs/INSTALL.md) | Требования, установка, сборка, запуск, CI |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Решение частых проблем |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура, инварианты, стек, структура каталогов |
| [docs/DESIGN.md](docs/DESIGN.md) | Дизайн-система (закреплено) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | План по фазам · [CHANGELOG.md](CHANGELOG.md) — история |
| [docs/TESTS.md](docs/TESTS.md) | Тестирование: слои, запуск, покрытие, CI |
| [CLAUDE.md](CLAUDE.md) | Правила разработки (для ИИ-ассистента и контрибьюторов) |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | Как контрибьютить · модель безопасности |

---

## Сеть и автономность

vterm работает **полностью офлайн**. Единственный сетевой доступ — исходящие
**SSH-подключения к серверам, которые вы сами добавили**. Нет CDN, телеметрии и
аналитики; шрифты встроены, секреты — локально в системном keychain. Инвариант
закреплён тест-гейтами (подробнее — в [docs/GUIDE.md](docs/GUIDE.md) и
[SECURITY.md](SECURITY.md)).

---

## Контакты разработчика

- **Telegram:** [@BorisToboltsov](https://t.me/BorisToboltsov)
- **Email:** [bt@vcore.su](mailto:bt@vcore.su)

---

## Лицензия

[MIT](LICENSE) © 2026 Тобольцов Борис Олегович
