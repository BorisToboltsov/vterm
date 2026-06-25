// Global, reactive application settings (Svelte 5 runes module).
//
// Persisted to localStorage — the app runs as an SPA inside a WebView, so sync
// access at import time is fine. UI theme changes are applied to the document
// automatically whenever the relevant settings change.

import {
  applyUiPalette,
  DEFAULT_THEME_ID,
  getTheme,
  type TerminalTheme,
} from "./themes";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n/locales";

export type CursorStyle = "block" | "bar" | "underline";
export type BellStyle = "none" | "sound" | "visual";
export type HostKeyPolicy = "strict" | "ask" | "accept";

/** Which metric groups the bottom status bar shows. */
export interface StatusBarItems {
  os: boolean;
  host: boolean;
  cpu: boolean;
  load: boolean;
  ram: boolean;
  swap: boolean;
  disk: boolean;
  diskio: boolean;
  net: boolean;
  netConns: boolean;
  uptime: boolean;
  users: boolean;
  ip: boolean;
  topProc: boolean;
  cpuTemp: boolean;
  kernel: boolean;
  serverTime: boolean;
}

/** Numeric metrics that support average/limit thresholds with colour coding. */
export type ThresholdKey =
  | "cpu"
  | "ram"
  | "swap"
  | "disk"
  | "load"
  | "cpuTemp"
  | "fd"
  | "inodes";

/** A pair of thresholds for one numeric metric; `null` disables that level. */
export interface Threshold {
  /** Average/soft limit — value at/above this is highlighted amber. */
  warn: number | null;
  /** Hard limit — value at/above this is highlighted red. */
  crit: number | null;
}

export type StatusBarThresholds = Record<ThresholdKey, Threshold>;

/**
 * Phase 10 "smart logs & text" terminal enhancements. `enabled` is the master
 * switch: turning it off makes the terminal behave exactly like before (plain
 * xterm — no search, no highlighting, no structured view), regardless of the
 * per-feature flags below.
 */
export interface SmartLogs {
  enabled: boolean; // master toggle
  search: boolean; // full-buffer search (Cmd/Ctrl+F)
  highlight: boolean; // regex highlighting (added in a later task)
  jsonView: boolean; // structured JSON log view (added in a later task)
}

/** Named highlight colour — rendered in the active theme's ANSI palette. */
export type HighlightColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

/** A single regex highlight rule for terminal output (Phase 10). */
export interface HighlightRule {
  id: string;
  name: string;
  pattern: string; // regex source
  color: HighlightColor;
  enabled: boolean;
  caseSensitive: boolean;
  wholeLine: boolean; // colour the entire line, not just the match
  bold: boolean;
  background: boolean; // colour the background instead of the text
}

/** What a session recording captures (mirrors `RecordMode` parsing in Rust). */
export type RecordMode = "full" | "fullNoTiming" | "commands";

/** Remembered options for the terminal buffer-search box. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Settings {
  // Language
  language: Locale; // UI language code (see src/lib/i18n)
  // Appearance
  theme: string; // preset id, or "custom"
  customTheme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  // Cursor
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  // Terminal
  scrollback: number;
  bell: BellStyle;
  copyOnSelect: boolean;
  middleClickPaste: boolean;
  // Behavior
  confirmCloseTab: boolean;
  // Connection
  connectTimeout: number; // seconds
  keepaliveInterval: number; // seconds
  termType: string;
  defaultPort: number;
  // Status bar
  showStatusBar: boolean;
  statusBarExpanded: boolean; // false = compact (icons + percentages)
  statusBarItems: StatusBarItems;
  statusBarThresholds: StatusBarThresholds;
  statusPollInterval: number; // seconds
  // Reconnect
  autoReconnect: boolean;
  // Logs & text (Phase 10)
  smartLogs: SmartLogs;
  highlightRules: HighlightRule[];
  searchOptions: SearchOptions;
  // Session recording (Phase 11)
  recordMaskPasswords: boolean; // redact input after password prompts
  recordMode: RecordMode;
  /** Pause recording after this many seconds idle on the active tab (0 = never). */
  recordIdlePauseSecs: number;
  // Security
  hostKeyPolicy: HostKeyPolicy;
}

/** Built-in starter highlight rules (a fresh copy each call). */
export function defaultHighlightRules(): HighlightRule[] {
  const base = { enabled: true, caseSensitive: false, wholeLine: false, bold: false, background: false };
  return [
    {
      id: "error",
      name: "ERROR/FATAL",
      pattern: "\\b(ERROR|FATAL|CRITICAL|FAILED|FAIL|PANIC)\\b",
      color: "red",
      ...base,
      bold: true,
    },
    {
      id: "warn",
      name: "WARNING",
      pattern: "\\b(WARN|WARNING)\\b",
      color: "yellow",
      ...base,
    },
    {
      id: "success",
      name: "SUCCESS/OK",
      pattern: "\\b(SUCCESS|SUCCEEDED|PASSED|READY|OK|UP|ONLINE|ACTIVE)\\b",
      color: "green",
      ...base,
    },
    {
      id: "ip",
      name: "IP",
      pattern: "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b",
      color: "blue",
      ...base,
    },
  ];
}

const DEFAULTS: Settings = {
  language: DEFAULT_LOCALE,
  theme: DEFAULT_THEME_ID,
  customTheme: { ...getTheme(DEFAULT_THEME_ID).terminal },
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.0,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  bell: "none",
  copyOnSelect: false,
  middleClickPaste: false,
  confirmCloseTab: true,
  connectTimeout: 10,
  keepaliveInterval: 15,
  termType: "xterm-256color",
  defaultPort: 22,
  showStatusBar: true,
  statusBarExpanded: false,
  statusBarItems: {
    os: true,
    host: true,
    cpu: true,
    load: true,
    ram: true,
    swap: true,
    disk: true,
    diskio: true,
    net: true,
    netConns: true,
    uptime: true,
    users: true,
    ip: true,
    topProc: true,
    cpuTemp: true,
    kernel: true,
    serverTime: true,
  },
  statusBarThresholds: {
    cpu: { warn: 80, crit: 95 },
    ram: { warn: 85, crit: 95 },
    swap: { warn: 50, crit: 90 },
    disk: { warn: 85, crit: 95 },
    load: { warn: null, crit: null },
    cpuTemp: { warn: 75, crit: 90 },
    fd: { warn: 80, crit: 95 },
    inodes: { warn: 85, crit: 95 },
  },
  statusPollInterval: 5,
  autoReconnect: false,
  smartLogs: {
    enabled: true,
    search: true,
    highlight: true,
    jsonView: true,
  },
  highlightRules: defaultHighlightRules(),
  searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
  recordMaskPasswords: true,
  recordMode: "full",
  recordIdlePauseSecs: 20,
  hostKeyPolicy: "ask",
};

const STORAGE_KEY = "vterm.settings";

/** Deep-merge a stored thresholds object onto defaults, key by key, ignoring junk. */
function mergeThresholds(raw: unknown): StatusBarThresholds {
  const out = {} as StatusBarThresholds;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS.statusBarThresholds) as ThresholdKey[]) {
    const def = DEFAULTS.statusBarThresholds[key];
    const v = r[key] as Partial<Threshold> | undefined;
    out[key] = {
      warn: typeof v?.warn === "number" ? v.warn : v?.warn === null ? null : def.warn,
      crit: typeof v?.crit === "number" ? v.crit : v?.crit === null ? null : def.crit,
    };
  }
  return out;
}

const HIGHLIGHT_COLORS: HighlightColor[] = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

/** Validate a stored highlight-rules array, falling back to defaults for junk. */
function mergeHighlightRules(raw: unknown): HighlightRule[] {
  if (!Array.isArray(raw)) return defaultHighlightRules();
  const out: HighlightRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pattern !== "string") continue;
    out.push({
      id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
      name: typeof r.name === "string" ? r.name : "",
      pattern: r.pattern,
      color: HIGHLIGHT_COLORS.includes(r.color as HighlightColor)
        ? (r.color as HighlightColor)
        : "yellow",
      enabled: r.enabled !== false,
      caseSensitive: r.caseSensitive === true,
      wholeLine: r.wholeLine === true,
      bold: r.bold === true,
      background: r.background === true,
    });
  }
  return out;
}

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...raw,
      language: isLocale(raw.language) ? raw.language : DEFAULTS.language,
      customTheme: { ...DEFAULTS.customTheme, ...(raw.customTheme ?? {}) },
      statusBarItems: { ...DEFAULTS.statusBarItems, ...(raw.statusBarItems ?? {}) },
      statusBarThresholds: mergeThresholds(raw.statusBarThresholds),
      smartLogs: { ...DEFAULTS.smartLogs, ...(raw.smartLogs ?? {}) },
      highlightRules: "highlightRules" in raw
        ? mergeHighlightRules(raw.highlightRules)
        : defaultHighlightRules(),
      searchOptions: { ...DEFAULTS.searchOptions, ...(raw.searchOptions ?? {}) },
      recordMode: (["full", "fullNoTiming", "commands"] as RecordMode[]).includes(raw.recordMode)
        ? raw.recordMode
        : DEFAULTS.recordMode,
      recordIdlePauseSecs:
        typeof raw.recordIdlePauseSecs === "number" && raw.recordIdlePauseSecs >= 0
          ? Math.floor(raw.recordIdlePauseSecs)
          : DEFAULTS.recordIdlePauseSecs,
    };
  } catch {
    return {
      ...DEFAULTS,
      customTheme: { ...DEFAULTS.customTheme },
      statusBarItems: { ...DEFAULTS.statusBarItems },
      statusBarThresholds: mergeThresholds(undefined),
      smartLogs: { ...DEFAULTS.smartLogs },
      highlightRules: defaultHighlightRules(),
      searchOptions: { ...DEFAULTS.searchOptions },
    };
  }
}

export const settings = $state<Settings>(load());

/** The resolved terminal palette (preset or the user's custom one). */
export function activeTerminalTheme(): TerminalTheme {
  return settings.theme === "custom"
    ? settings.customTheme
    : getTheme(settings.theme).terminal;
}

/** Reset all settings to their defaults. */
export function resetSettings(): void {
  Object.assign(settings, {
    ...DEFAULTS,
    customTheme: { ...DEFAULTS.customTheme },
    statusBarItems: { ...DEFAULTS.statusBarItems },
    statusBarThresholds: mergeThresholds(undefined),
    smartLogs: { ...DEFAULTS.smartLogs },
    highlightRules: defaultHighlightRules(),
    searchOptions: { ...DEFAULTS.searchOptions },
  });
}

/**
 * Apply a settings snapshot restored from a backup. Only known keys are taken
 * (unknown junk is ignored); missing keys fall back to defaults — same merge as
 * load(). Safe to call with arbitrary parsed JSON.
 */
export function applyImportedSettings(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const next: Settings = {
    ...DEFAULTS,
    customTheme: { ...DEFAULTS.customTheme },
    statusBarItems: { ...DEFAULTS.statusBarItems },
    statusBarThresholds: mergeThresholds(undefined),
    smartLogs: { ...DEFAULTS.smartLogs },
    highlightRules: defaultHighlightRules(),
    searchOptions: { ...DEFAULTS.searchOptions },
  };
  const sink = next as unknown as Record<string, unknown>;
  const nested = [
    "customTheme",
    "statusBarItems",
    "statusBarThresholds",
    "smartLogs",
    "highlightRules",
    "searchOptions",
  ];
  for (const key of Object.keys(DEFAULTS)) {
    if (!nested.includes(key) && key in r) {
      sink[key] = r[key];
    }
  }
  if (!isLocale(next.language)) next.language = DEFAULTS.language;
  if (r.customTheme && typeof r.customTheme === "object") {
    next.customTheme = { ...DEFAULTS.customTheme, ...(r.customTheme as Partial<TerminalTheme>) };
  }
  if (r.statusBarItems && typeof r.statusBarItems === "object") {
    next.statusBarItems = {
      ...DEFAULTS.statusBarItems,
      ...(r.statusBarItems as Partial<StatusBarItems>),
    };
  }
  if (r.statusBarThresholds !== undefined) {
    next.statusBarThresholds = mergeThresholds(r.statusBarThresholds);
  }
  if (r.smartLogs && typeof r.smartLogs === "object") {
    next.smartLogs = { ...DEFAULTS.smartLogs, ...(r.smartLogs as Partial<SmartLogs>) };
  }
  if (r.highlightRules !== undefined) {
    next.highlightRules = mergeHighlightRules(r.highlightRules);
  }
  if (r.searchOptions && typeof r.searchOptions === "object") {
    next.searchOptions = { ...DEFAULTS.searchOptions, ...(r.searchOptions as Partial<SearchOptions>) };
  }
  Object.assign(settings, next);
}

// Persist on any change and keep the UI chrome in sync with the chosen theme.
// `$effect.root` lives for the whole app session (never torn down).
$effect.root(() => {
  $effect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable — non-fatal */
    }
  });

  $effect(() => {
    // For a custom terminal theme keep the surrounding chrome on a neutral dark
    // palette; presets carry their own coordinated UI palette.
    if (settings.theme !== "custom") {
      applyUiPalette(getTheme(settings.theme).ui);
    }
  });
});
