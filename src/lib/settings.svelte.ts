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

export interface Settings {
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
  statusPollInterval: number; // seconds
  // Reconnect
  autoReconnect: boolean;
  // Security
  hostKeyPolicy: HostKeyPolicy;
}

const DEFAULTS: Settings = {
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
  statusPollInterval: 5,
  autoReconnect: false,
  hostKeyPolicy: "ask",
};

const STORAGE_KEY = "vterm.settings";

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...raw,
      customTheme: { ...DEFAULTS.customTheme, ...(raw.customTheme ?? {}) },
      statusBarItems: { ...DEFAULTS.statusBarItems, ...(raw.statusBarItems ?? {}) },
    };
  } catch {
    return {
      ...DEFAULTS,
      customTheme: { ...DEFAULTS.customTheme },
      statusBarItems: { ...DEFAULTS.statusBarItems },
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
  };
  const sink = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS)) {
    if (key !== "customTheme" && key !== "statusBarItems" && key in r) {
      sink[key] = r[key];
    }
  }
  if (r.customTheme && typeof r.customTheme === "object") {
    next.customTheme = { ...DEFAULTS.customTheme, ...(r.customTheme as Partial<TerminalTheme>) };
  }
  if (r.statusBarItems && typeof r.statusBarItems === "object") {
    next.statusBarItems = {
      ...DEFAULTS.statusBarItems,
      ...(r.statusBarItems as Partial<StatusBarItems>),
    };
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
