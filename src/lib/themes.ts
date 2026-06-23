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
  /** Warning/threshold amber. Optional — defaults to a fixed amber when omitted. */
  warn?: string;
  muted: string;
  text: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  group: "light" | "modern" | "retro";
  terminal: TerminalTheme;
  ui: UiPalette;
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

export const THEMES: ThemeDef[] = [
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

export const DEFAULT_THEME_ID = catppuccin.id;

export function getTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? catppuccin;
}

/** Representative colors for a theme preview chip (bg, fg, accent, ok, warn, err). */
export function themeSwatches(t: ThemeDef): string[] {
  const term = t.terminal;
  return [term.background, term.foreground, term.blue, term.green, term.yellow, term.red];
}

/** Apply a UI palette to the document by overriding Tailwind's `--color-*` tokens. */
export function applyUiPalette(ui: UiPalette): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--color-panel", ui.panel);
  root.setProperty("--color-panel-alt", ui.panelAlt);
  root.setProperty("--color-edge", ui.edge);
  root.setProperty("--color-accent", ui.accent);
  root.setProperty("--color-accent-hover", ui.accentHover);
  root.setProperty("--color-danger", ui.danger);
  // Warn (threshold amber) is optional per theme; fall back to a fixed amber.
  root.setProperty("--color-warn", ui.warn ?? "#e5a50a");
  root.setProperty("--color-muted", ui.muted);
  root.setProperty("--color-text", ui.text);
}
