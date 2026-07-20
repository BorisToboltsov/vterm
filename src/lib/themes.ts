// Theme catalogue for vterm: each theme carries a full xterm.js terminal palette
// (background/foreground/cursor + 16 ANSI colors) and a small UI palette that
// drives the surrounding chrome via CSS custom properties (see app.css @theme).

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Colors for the app chrome (mapped onto Tailwind `--color-*` tokens). */
export interface UiPalette {
  panel: string;
  panelAlt: string;
  edge: string;
  accent: string;
  accentHover: string;
  danger: string;
  /**
   * Semantic status trio (Phase 43): healthy / degraded / broken. Used by every
   * state dot, success mark and warning badge in the app, and by the diff tints
   * derived from them in app.css.
   *
   * All three are optional and fall back per theme *group* (see `statusPalette`),
   * because the whole point of moving them off Tailwind's palette is that a fixed
   * value cannot serve both a near-black and a cream panel: the previous
   * hard-coded `bg-amber-400` was invisible on Solarized Light. A theme only needs
   * to name them when its own defaults would be wrong.
   */
  ok?: string;
  /** Warning/threshold amber. Optional — see `ok`. */
  warn?: string;
  bad?: string;
  muted: string;
  text: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  group: "light" | "modern" | "retro" | "signature";
  terminal: TerminalTheme;
  ui: UiPalette;
  /**
   * Signature themes only: a rich CSS `background` gradient used for the **in-app
   * logo** icon square ([AppLogo.svelte](../AppLogo.svelte)) so the icon re-themes
   * with the app; it mirrors the static OS bundle icon's look. Classic themes omit
   * it (the logo falls back to the flat panel colour).
   */
  backdrop?: string;
  /**
   * Signature themes only: a **subtle** CSS `background` painted as a full-window
   * layer *on top* of the whole app (pointer-events:none, below modals) via
   * [ThemeOverlay.svelte](../ThemeOverlay.svelte). Because it sits above the
   * (opaque, WebGL-rendered) terminal *and* the chrome, both share the same
   * dimensional tint — no seam, full readability, no renderer/perf cost. Keep it
   * faint (edge vignette / corner glow / diagonal sheen), never over ~0.3 alpha.
   */
  overlay?: string;
}

// ── Modern schemes ────────────────────────────────────────────────────────────

const catppuccin: ThemeDef = {
  id: "catppuccin",
  name: "Catppuccin Mocha",
  group: "modern",
  terminal: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#cdd6f4",
    selectionBackground: "#585b70",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  ui: {
    panel: "#1e1e2e",
    panelAlt: "#181825",
    edge: "#313244",
    accent: "#89b4fa",
    accentHover: "#b4befe",
    danger: "#f38ba8",
    muted: "#6c7086",
    text: "#cdd6f4",
  },
};

const dracula: ThemeDef = {
  id: "dracula",
  name: "Dracula",
  group: "modern",
  terminal: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  ui: {
    panel: "#282a36",
    panelAlt: "#21222c",
    edge: "#44475a",
    accent: "#bd93f9",
    accentHover: "#d6acff",
    danger: "#ff5555",
    muted: "#6272a4",
    text: "#f8f8f2",
  },
};

const nord: ThemeDef = {
  id: "nord",
  name: "Nord",
  group: "modern",
  terminal: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  ui: {
    panel: "#2e3440",
    panelAlt: "#272c36",
    edge: "#434c5e",
    accent: "#88c0d0",
    accentHover: "#8fbcbb",
    danger: "#bf616a",
    muted: "#7b88a1",
    text: "#d8dee9",
  },
};

const gruvbox: ThemeDef = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  group: "modern",
  terminal: {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  ui: {
    panel: "#282828",
    panelAlt: "#1d2021",
    edge: "#3c3836",
    accent: "#fabd2f",
    accentHover: "#fe8019",
    danger: "#fb4934",
    muted: "#928374",
    text: "#ebdbb2",
  },
};

const solarizedDark: ThemeDef = {
  id: "solarized-dark",
  name: "Solarized Dark",
  group: "modern",
  terminal: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  ui: {
    panel: "#002b36",
    panelAlt: "#073642",
    edge: "#0e4b59",
    accent: "#268bd2",
    accentHover: "#2aa198",
    danger: "#dc322f",
    muted: "#586e75",
    text: "#93a1a1",
  },
};

const tokyoNight: ThemeDef = {
  id: "tokyo-night",
  name: "Tokyo Night",
  group: "modern",
  terminal: {
    background: "#1a1b26",
    foreground: "#a9b1d6",
    cursor: "#c0caf5",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  ui: {
    panel: "#1a1b26",
    panelAlt: "#16161e",
    edge: "#2a2e42",
    accent: "#7aa2f7",
    accentHover: "#bb9af7",
    danger: "#f7768e",
    muted: "#565f89",
    text: "#a9b1d6",
  },
};

const oneDark: ThemeDef = {
  id: "one-dark",
  name: "One Dark",
  group: "modern",
  terminal: {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  ui: {
    panel: "#282c34",
    panelAlt: "#21252b",
    edge: "#3e4451",
    accent: "#61afef",
    accentHover: "#c678dd",
    danger: "#e06c75",
    muted: "#5c6370",
    text: "#abb2bf",
  },
};

// ── Retro / thematic schemes ────────────────────────────────────────────────

const fallout: ThemeDef = {
  id: "fallout",
  name: "Fallout Pip-Boy",
  group: "retro",
  terminal: {
    background: "#0a1a0a",
    foreground: "#33ff66",
    cursor: "#33ff66",
    selectionBackground: "#155515",
    black: "#0a1a0a",
    red: "#1f9f3f",
    green: "#33ff66",
    yellow: "#2fd957",
    blue: "#1f9f3f",
    magenta: "#33ff66",
    cyan: "#2fd957",
    white: "#33ff66",
    brightBlack: "#155515",
    brightRed: "#46ff77",
    brightGreen: "#7dff9e",
    brightYellow: "#46ff77",
    brightBlue: "#46ff77",
    brightMagenta: "#7dff9e",
    brightCyan: "#7dff9e",
    brightWhite: "#bfffcf",
  },
  ui: {
    panel: "#0a1a0a",
    panelAlt: "#061206",
    edge: "#155515",
    accent: "#33ff66",
    accentHover: "#7dff9e",
    danger: "#ff5555",
    muted: "#1f9f3f",
    text: "#33ff66",
  },
};

const amber: ThemeDef = {
  id: "amber",
  name: "Amber CRT",
  group: "retro",
  terminal: {
    background: "#1a1000",
    foreground: "#ffb000",
    cursor: "#ffb000",
    selectionBackground: "#553a00",
    black: "#1a1000",
    red: "#cc7000",
    green: "#ffb000",
    yellow: "#ffcc33",
    blue: "#cc7000",
    magenta: "#ffb000",
    cyan: "#ffcc33",
    white: "#ffb000",
    brightBlack: "#553a00",
    brightRed: "#ffcc33",
    brightGreen: "#ffd866",
    brightYellow: "#ffe199",
    brightBlue: "#ffcc33",
    brightMagenta: "#ffd866",
    brightCyan: "#ffe199",
    brightWhite: "#fff0cc",
  },
  ui: {
    panel: "#1a1000",
    panelAlt: "#120b00",
    edge: "#553a00",
    accent: "#ffb000",
    accentHover: "#ffcc33",
    danger: "#ff5555",
    muted: "#cc7000",
    text: "#ffb000",
  },
};

const ibm3270: ThemeDef = {
  id: "ibm-3270",
  name: "IBM 3270",
  group: "retro",
  terminal: {
    background: "#000000",
    foreground: "#33ff33",
    cursor: "#33ff33",
    selectionBackground: "#0a3a0a",
    black: "#000000",
    red: "#1faf1f",
    green: "#33ff33",
    yellow: "#33ff33",
    blue: "#1faf1f",
    magenta: "#33ff33",
    cyan: "#33ff33",
    white: "#33ff33",
    brightBlack: "#0a3a0a",
    brightRed: "#5aff5a",
    brightGreen: "#5aff5a",
    brightYellow: "#5aff5a",
    brightBlue: "#5aff5a",
    brightMagenta: "#5aff5a",
    brightCyan: "#5aff5a",
    brightWhite: "#aaffaa",
  },
  ui: {
    panel: "#000000",
    panelAlt: "#040c04",
    edge: "#0a3a0a",
    accent: "#33ff33",
    accentHover: "#5aff5a",
    danger: "#ff5555",
    muted: "#1faf1f",
    text: "#33ff33",
  },
};

const c64: ThemeDef = {
  id: "c64",
  name: "Commodore 64",
  group: "retro",
  terminal: {
    background: "#40318d",
    foreground: "#7c70da",
    cursor: "#7c70da",
    selectionBackground: "#5a4ba8",
    black: "#000000",
    red: "#883932",
    green: "#55a049",
    yellow: "#bfce72",
    blue: "#40318d",
    magenta: "#8b3f96",
    cyan: "#67b6bd",
    white: "#9f9f9f",
    brightBlack: "#5a4ba8",
    brightRed: "#b86962",
    brightGreen: "#94e089",
    brightYellow: "#ffffb2",
    brightBlue: "#7c70da",
    brightMagenta: "#bb71c6",
    brightCyan: "#a7e6ed",
    brightWhite: "#ffffff",
  },
  ui: {
    panel: "#40318d",
    panelAlt: "#352a76",
    edge: "#5a4ba8",
    accent: "#7c70da",
    accentHover: "#a7e6ed",
    danger: "#b86962",
    muted: "#9f9f9f",
    text: "#cdc8f5",
  },
};

// ── Light schemes ─────────────────────────────────────────────────────────────

const solarizedLight: ThemeDef = {
  id: "solarized-light",
  name: "Solarized Light",
  group: "light",
  terminal: {
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#586e75",
    selectionBackground: "#eee8d5",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  ui: {
    panel: "#fdf6e3",
    panelAlt: "#eee8d5",
    edge: "#ddd6c1",
    accent: "#268bd2",
    accentHover: "#1f6fa8",
    danger: "#dc322f",
    muted: "#93a1a1",
    text: "#586e75",
  },
};

const githubLight: ThemeDef = {
  id: "github-light",
  name: "GitHub Light",
  group: "light",
  terminal: {
    background: "#ffffff",
    foreground: "#24292e",
    cursor: "#044289",
    selectionBackground: "#c8e1ff",
    black: "#24292e",
    red: "#d73a49",
    green: "#28a745",
    yellow: "#dbab09",
    blue: "#0366d6",
    magenta: "#5a32a3",
    cyan: "#0598bc",
    white: "#6a737d",
    brightBlack: "#959da5",
    brightRed: "#cb2431",
    brightGreen: "#22863a",
    brightYellow: "#b08800",
    brightBlue: "#005cc5",
    brightMagenta: "#5a32a3",
    brightCyan: "#3192aa",
    brightWhite: "#d1d5da",
  },
  ui: {
    panel: "#ffffff",
    panelAlt: "#f6f8fa",
    edge: "#d0d7de",
    accent: "#0366d6",
    accentHover: "#0356b6",
    danger: "#d73a49",
    muted: "#6a737d",
    text: "#24292e",
  },
};

const catppuccinLatte: ThemeDef = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  group: "light",
  terminal: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#4c4f69",
    selectionBackground: "#bcc0cc",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  },
  ui: {
    panel: "#eff1f5",
    panelAlt: "#e6e9ef",
    edge: "#ccd0da",
    accent: "#1e66f5",
    accentHover: "#1552c9",
    danger: "#d20f39",
    muted: "#8c8fa1",
    text: "#4c4f69",
  },
};

const gruvboxLight: ThemeDef = {
  id: "gruvbox-light",
  name: "Gruvbox Light",
  group: "light",
  terminal: {
    background: "#fbf1c7",
    foreground: "#3c3836",
    cursor: "#3c3836",
    selectionBackground: "#ebdbb2",
    black: "#fbf1c7",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#7c6f64",
    brightBlack: "#928374",
    brightRed: "#9d0006",
    brightGreen: "#79740e",
    brightYellow: "#b57614",
    brightBlue: "#076678",
    brightMagenta: "#8f3f71",
    brightCyan: "#427b58",
    brightWhite: "#3c3836",
  },
  ui: {
    panel: "#fbf1c7",
    panelAlt: "#f2e5bc",
    edge: "#ebdbb2",
    accent: "#458588",
    accentHover: "#076678",
    danger: "#cc241d",
    muted: "#7c6f64",
    text: "#3c3836",
  },
};

// ── Signature schemes (dimensional backdrop, locked palette) ────────────────────
// These three are vterm's own brand themes: each carries a coordinated palette
// *and* a `backdrop` gradient that paints the whole app + the in-app logo. Their
// chrome panels are intentionally translucent (rgba) so the backdrop breathes
// through; the terminal keeps a solid, readable background. Colours are fixed
// (no per-theme editing — that stays the "custom" theme's job); only font and
// spacing remain adjustable. Deep Well is the app default.

const deepWell: ThemeDef = {
  id: "deep-well",
  name: "Deep Well",
  group: "signature",
  backdrop: "radial-gradient(125% 105% at 50% 40%, #04050a 0%, #0b0f18 60%, #1a2233 100%)",
  overlay:
    "radial-gradient(120% 85% at 50% 20%, rgba(125,179,255,0.05), transparent 46%), radial-gradient(150% 130% at 50% 52%, transparent 55%, rgba(0,0,0,0.28))",
  terminal: {
    background: "#0b0f18",
    foreground: "#cdd6e6",
    cursor: "#7db3ff",
    selectionBackground: "#24344d",
    black: "#0b0f18",
    red: "#f2707a",
    green: "#5fd39a",
    yellow: "#e6b866",
    blue: "#7da7ff",
    magenta: "#b79cff",
    cyan: "#67d5e0",
    white: "#cdd6e6",
    brightBlack: "#3a465c",
    brightRed: "#ff8790",
    brightGreen: "#7fe3b4",
    brightYellow: "#f4cf8a",
    brightBlue: "#a9ccff",
    brightMagenta: "#cdb8ff",
    brightCyan: "#8fe6ee",
    brightWhite: "#eef3fb",
  },
  ui: {
    // Opaque, toned to the terminal background (#0b0f18) so terminal + chrome read
    // as one surface; depth comes from the ThemeOverlay layer, not translucency.
    panel: "#0d131e",
    panelAlt: "#0a0f18",
    edge: "#1e2a3f",
    accent: "#7db3ff",
    accentHover: "#a9ccff",
    danger: "#f2707a",
    warn: "#e6b866",
    muted: "#5f6b80",
    text: "#cdd6e6",
  },
};

const aurora: ThemeDef = {
  id: "aurora",
  name: "Aurora",
  group: "signature",
  backdrop:
    "radial-gradient(52% 46% at 20% 28%, rgba(52,211,153,0.22), transparent 70%), radial-gradient(56% 52% at 82% 80%, rgba(167,139,250,0.24), transparent 72%), #04060a",
  overlay:
    "radial-gradient(46% 42% at 12% 12%, rgba(52,211,153,0.10), transparent 60%), radial-gradient(50% 46% at 90% 92%, rgba(167,139,250,0.12), transparent 62%), radial-gradient(150% 130% at 50% 50%, transparent 58%, rgba(0,0,0,0.26))",
  terminal: {
    background: "#080b12",
    foreground: "#d7e0e8",
    cursor: "#34d399",
    selectionBackground: "#38486e",
    black: "#0c1018",
    red: "#fb7185",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#818cf8",
    magenta: "#c084fc",
    cyan: "#2dd4bf",
    white: "#d7e0e8",
    brightBlack: "#3b465f",
    brightRed: "#ff92a3",
    brightGreen: "#79f0a0",
    brightYellow: "#ffd45e",
    brightBlue: "#a3abff",
    brightMagenta: "#d9b3ff",
    brightCyan: "#5fe6d2",
    brightWhite: "#eef4f6",
  },
  ui: {
    // Opaque, toned to the terminal background (#080b12); depth via ThemeOverlay.
    panel: "#0a0e16",
    panelAlt: "#070b12",
    edge: "#2a3350",
    accent: "#34d399",
    accentHover: "#6ee7b7",
    danger: "#fb7185",
    warn: "#fbbf24",
    muted: "#6b7488",
    text: "#d7e0e8",
  },
};

const glass: ThemeDef = {
  id: "glass",
  name: "Glass",
  group: "signature",
  backdrop:
    "linear-gradient(118deg, transparent 34%, rgba(255,255,255,0.05) 50%, transparent 66%), linear-gradient(135deg, #151a24 0%, #06070a 100%)",
  overlay:
    "linear-gradient(118deg, transparent 40%, rgba(255,255,255,0.06) 50%, transparent 60%), radial-gradient(150% 130% at 50% 50%, transparent 56%, rgba(0,0,0,0.24))",
  terminal: {
    background: "#10151d",
    foreground: "#d4dae2",
    cursor: "#8ab4d8",
    selectionBackground: "#283444",
    black: "#10151d",
    red: "#dd8b8b",
    green: "#86c99a",
    yellow: "#d8c07a",
    blue: "#86aedd",
    magenta: "#b49ad0",
    cyan: "#7fc4cc",
    white: "#d4dae2",
    brightBlack: "#3d4756",
    brightRed: "#e9a6a6",
    brightGreen: "#a2ddb2",
    brightYellow: "#e6d29a",
    brightBlue: "#a6c6e8",
    brightMagenta: "#ccb4e0",
    brightCyan: "#9fd8de",
    brightWhite: "#eaeef3",
  },
  ui: {
    // Opaque, toned to the terminal background (#10151d); depth via ThemeOverlay.
    panel: "#12171f",
    panelAlt: "#0e131b",
    edge: "#283040",
    accent: "#8ab4d8",
    accentHover: "#aecce6",
    danger: "#dd8b8b",
    warn: "#d8c07a",
    muted: "#68727f",
    text: "#d4dae2",
  },
};

export const THEMES: ThemeDef[] = [
  deepWell,
  aurora,
  glass,
  catppuccin,
  dracula,
  nord,
  gruvbox,
  solarizedDark,
  tokyoNight,
  oneDark,
  solarizedLight,
  githubLight,
  catppuccinLatte,
  gruvboxLight,
  fallout,
  amber,
  ibm3270,
  c64,
];

export const DEFAULT_THEME_ID = deepWell.id;

export function getTheme(id: string): ThemeDef {
  // Unknown ids fall back to the default theme (kept in sync with DEFAULT_THEME_ID).
  return THEMES.find((t) => t.id === id) ?? deepWell;
}

/** Representative colors for a theme preview chip (bg, fg, accent, ok, warn, err). */
export function themeSwatches(t: ThemeDef): string[] {
  const term = t.terminal;
  return [term.background, term.foreground, term.blue, term.green, term.yellow, term.red];
}

/** Status colours for dark panels — bright enough to read against a near-black surface. */
export const STATUS_DARK = { ok: "#4ade80", warn: "#e5a50a", bad: "#ef4444" } as const;
/**
 * Status colours for light panels. Deliberately much darker: the dark-theme trio
 * on a cream panel (Solarized Light's `#fdf6e3`) is what this phase set out to
 * fix — a `#e5a50a` dot on cream is barely a smudge.
 */
export const STATUS_LIGHT = { ok: "#15803d", warn: "#b45309", bad: "#b91c1c" } as const;

/**
 * Resolve a theme's status trio: whatever the palette names explicitly wins,
 * anything it leaves out comes from the group default. Pure so the "light themes
 * must not inherit dark defaults" rule is testable without a DOM.
 */
export function statusPalette(
  ui: UiPalette,
  light: boolean,
): { ok: string; warn: string; bad: string } {
  const base = light ? STATUS_LIGHT : STATUS_DARK;
  return { ok: ui.ok ?? base.ok, warn: ui.warn ?? base.warn, bad: ui.bad ?? base.bad };
}

/**
 * Apply a UI palette to the document by overriding Tailwind's `--color-*` tokens.
 * `light` selects the status-trio defaults (see `statusPalette`) and comes from the
 * theme's group — a palette alone cannot tell whether its panels are light.
 */
export function applyUiPalette(ui: UiPalette, light = false): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--color-panel", ui.panel);
  root.setProperty("--color-panel-alt", ui.panelAlt);
  root.setProperty("--color-edge", ui.edge);
  root.setProperty("--color-accent", ui.accent);
  root.setProperty("--color-accent-hover", ui.accentHover);
  root.setProperty("--color-danger", ui.danger);
  const status = statusPalette(ui, light);
  root.setProperty("--color-ok", status.ok);
  root.setProperty("--color-warn", status.warn);
  root.setProperty("--color-bad", status.bad);
  root.setProperty("--color-muted", ui.muted);
  root.setProperty("--color-text", ui.text);
}
