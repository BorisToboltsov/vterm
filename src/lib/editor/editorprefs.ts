// The editor's settings (ADR 0076): what the status bar and «Settings → Editor»
// switch, the language a file was set to by hand, the formatter picked per
// language, the language servers allowed to start by themselves. Sanitised on
// every read — a hand-edited or older store never reaches the editor broken.

import { LANG_CHOICES, type EditorLangKind } from "./editorlang";

export interface EditorSettings {
  /** Show a before/after diff dialog before writing a changed file to the server. */
  diffBeforeSave: boolean;
  /** Keep a `.bak` copy of the file on the server before overwriting (Phase 12.6). */
  backupOnSave: boolean;
  /**
   * The first file of a connection opens in a zone of its own beside the
   * terminal, not over it (v1.35) — when the terminal has the room.
   */
  openBeside: boolean;
  /** Long lines wrap at the edge (on: as before v1.37). */
  wrap: boolean;
  /** The miniature of the file at the right edge. */
  minimap: boolean;
  /** Format with the file's formatter before every save (before the diff, so it shows). */
  formatOnSave: boolean;
  closeBrackets: boolean;
  autocomplete: boolean;
  indentGuides: boolean;
  /** Tint the trailing spaces a save would carry. */
  trailingSpace: boolean;
  /** A language set by hand, by `langKey` of the file — remembered. */
  langOverrides: Record<string, EditorLangKind>;
  /** The formatter picked per language kind (the format menu's ●). */
  formatters: Record<string, string>;
  /** Language servers that start by themselves: `lspKey` of host, folder and server. */
  lspAuto: string[];
}

export const EDITOR_DEFAULTS: EditorSettings = {
  diffBeforeSave: true,
  backupOnSave: false,
  openBeside: false,
  wrap: true,
  minimap: false,
  formatOnSave: false,
  closeBrackets: true,
  autocomplete: true,
  indentGuides: true,
  trailingSpace: true,
  langOverrides: {},
  formatters: {},
  lspAuto: [],
};

/** How many hand-set languages and auto-started servers are kept (oldest go first). */
export const MAX_OVERRIDES = 300;
export const MAX_LSP_AUTO = 200;

const KINDS = new Set<string>(LANG_CHOICES.map((l) => l.kind));

/** The key a hand-set language is remembered under. */
export function langKey(source: "sftp" | "local", path: string): string {
  return `${source}:${path}`;
}

/** The editor settings from whatever was stored, every field checked. */
export function sanitizeEditorSettings(raw: unknown): EditorSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof EditorSettings) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (EDITOR_DEFAULTS[k] as boolean));
  const overrides: Record<string, EditorLangKind> = {};
  if (r.langOverrides && typeof r.langOverrides === "object") {
    const entries = Object.entries(r.langOverrides as Record<string, unknown>).filter(
      ([k, v]) => typeof v === "string" && KINDS.has(v) && k.length <= 4096,
    );
    for (const [k, v] of entries.slice(-MAX_OVERRIDES)) overrides[k] = v as EditorLangKind;
  }
  const formatters: Record<string, string> = {};
  if (r.formatters && typeof r.formatters === "object") {
    for (const [k, v] of Object.entries(r.formatters as Record<string, unknown>)) {
      if (KINDS.has(k) && typeof v === "string" && /^[\w.-]{1,40}$/.test(v)) formatters[k] = v;
    }
  }
  const lspAuto = Array.isArray(r.lspAuto)
    ? [...new Set(r.lspAuto.filter((x): x is string => typeof x === "string" && x.length <= 4096))].slice(-MAX_LSP_AUTO)
    : [];
  return {
    diffBeforeSave: bool("diffBeforeSave"),
    backupOnSave: bool("backupOnSave"),
    openBeside: bool("openBeside"),
    wrap: bool("wrap"),
    minimap: bool("minimap"),
    formatOnSave: bool("formatOnSave"),
    closeBrackets: bool("closeBrackets"),
    autocomplete: bool("autocomplete"),
    indentGuides: bool("indentGuides"),
    trailingSpace: bool("trailingSpace"),
    langOverrides: overrides,
    formatters,
    lspAuto,
  };
}

/** `overrides` with `key` set to `kind` (moved to the newest), or dropped when `kind` is null. */
export function withOverride(
  overrides: Readonly<Record<string, EditorLangKind>>,
  key: string,
  kind: EditorLangKind | null,
): Record<string, EditorLangKind> {
  const next = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== key));
  if (kind) next[key] = kind;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_OVERRIDES))) delete next[k];
  return next;
}
