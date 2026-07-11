// Pure navigation model for the Settings panel (two-pane layout, Phase 15).
// Sections are grouped into a small sidebar; search filters across all groups.
// Kept DOM-free so it is unit-tested directly (architecture invariant).
import { matchesQuery } from "./util";
import type { IconName } from "./icons";

export interface SettingsSection {
  id: string;
  /** Bilingual (EN+RU) search keywords — never displayed, only matched. */
  keywords: string;
}

export interface SettingsGroup {
  id: string;
  /** Icon registry name (see icons.ts). */
  icon: IconName;
  /** Section ids belonging to this group, in display order. */
  sections: string[];
}

// All settings sections with their search keywords. Order within a group is the
// render order in the right pane.
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "language", keywords: "Language locale язык локаль english русский ru en интерфейс" },
  { id: "appearance", keywords: "Appearance theme font color size line height light dark preview custom внешний вид тема шрифт цвет размер" },
  { id: "cursor", keywords: "Cursor blink block bar underline курсор мигание блок линия подчёркивание" },
  { id: "terminal", keywords: "Terminal scrollback bell copy paste selection middle click local shell cmd powershell pwsh windows терминал буфер сигнал копировать вставка локальный шелл оболочка виндовс" },
  { id: "smartlogs", keywords: "Logs text smart search find buffer highlight json structured логи текст поиск подсветка буфер регулярные" },
  { id: "recording", keywords: "Recording session asciicast password mask privacy idle pause auto запись сессий пароль маскирование приватность простой пауза автозапись" },
  { id: "sftp", keywords: "SFTP files file size open editor megabytes mb limit max файлы файл размер открыть редактор мегабайт лимит" },
  { id: "servertools", keywords: "server tools install linter linters yamllint shellcheck hadolint ruff sensors temperature lm-sensors monitoring package manager apt dnf серверные инструменты установка линтер линтеры датчики температура мониторинг пакетный менеджер" },
  { id: "snippets", keywords: "snippets templates editor insert dockerfile nginx compose systemd kubernetes bash шаблоны сниппеты вставка редактор докерфайл" },
  { id: "editor", keywords: "Editor config diff lint save yaml json syntax highlight редактор конфиг дифф различия линт сохранение синтаксис проверка подсветка" },
  { id: "behavior", keywords: "Behavior confirm close tab auto reconnect поведение подтверждение вкладка переподключение" },
  { id: "connection", keywords: "Connection timeout keepalive default port подключение таймаут порт" },
  { id: "statusbar", keywords: "Status bar metrics poll interval cpu ram disk threshold thresholds warn limit average пороги monitoring мониторинг статус-бар метрики" },
  { id: "security", keywords: "Security host key known_hosts policy strict trust accept безопасность ключ хоста политика" },
  { id: "backup", keywords: "Backup export import json restore резервная копия бэкап экспорт импорт восстановление" },
  { id: "ai", keywords: "AI assistant LLM chat model endpoint api key qwen ollama vllm claude anthropic openai prod ИИ ассистент чат модель эндпоинт ключ помощник нейросеть" },
];

// Sidebar groups. Every section id appears in exactly one group (guarded by a test).
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: "general", icon: "settings", sections: ["language", "behavior", "backup"] },
  { id: "appearance", icon: "eye", sections: ["appearance", "cursor"] },
  { id: "terminal", icon: "terminal", sections: ["terminal", "smartlogs"] },
  { id: "connection", icon: "plug", sections: ["connection", "security"] },
  { id: "files", icon: "code", sections: ["sftp", "editor", "snippets"] },
  { id: "sessions", icon: "activity", sections: ["recording", "statusbar", "servertools"] },
  { id: "assistant", icon: "aiMark", sections: ["ai"] },
];

export const DEFAULT_SETTINGS_GROUP = SETTINGS_GROUPS[0].id;

/** Section ids whose keywords match the search query (across all groups). */
export function sectionsMatching(search: string): Set<string> {
  return new Set(
    SETTINGS_SECTIONS.filter((s) => matchesQuery(s.keywords, search)).map((s) => s.id),
  );
}

/** Section ids of a group, in registry order (empty for an unknown group). */
export function groupSections(groupId: string): string[] {
  return SETTINGS_GROUPS.find((g) => g.id === groupId)?.sections ?? [];
}

/** Group id that owns a section, or null if the section is unknown (deep-link). */
export function groupForSection(sectionId: string): string | null {
  return SETTINGS_GROUPS.find((g) => g.sections.includes(sectionId))?.id ?? null;
}

/**
 * Which sections are visible: search results when searching (cross-group),
 * otherwise the sections of the active group.
 */
export function visibleSectionIds(search: string, activeGroupId: string): Set<string> {
  if (search.trim()) return sectionsMatching(search);
  return new Set(groupSections(activeGroupId));
}

/** Per-group count of sections matching the search (0 for every group when not searching). */
export function groupMatchCounts(search: string): Record<string, number> {
  const out: Record<string, number> = {};
  const matched = search.trim() ? sectionsMatching(search) : null;
  for (const g of SETTINGS_GROUPS) {
    out[g.id] = matched ? g.sections.filter((id) => matched.has(id)).length : 0;
  }
  return out;
}
