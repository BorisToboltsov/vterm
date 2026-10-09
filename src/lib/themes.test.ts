import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./colormix";
import {
  applyUiPalette,
  statusPalette,
  STATUS_DARK,
  STATUS_LIGHT,
  DEFAULT_THEME_ID,
  getTheme,
  THEMES,
  themeSwatches,
  type ThemeDef,
  type TerminalTheme,
  type UiPalette,
} from "./themes";

const TERMINAL_KEYS: (keyof TerminalTheme)[] = [
  "background", "foreground", "cursor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
const UI_KEYS: (keyof UiPalette)[] = [
  "panel", "panelAlt", "edge", "accent", "accentHover", "danger", "muted", "text",
];

const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
const isRgba = (v: string) => /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(v);

describe("theme catalogue integrity", () => {
  it("has a unique id per theme", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(THEMES.map((t) => [t.name, t] as const))(
    "%s has a valid colour for every palette key",
    (_name, theme) => {
      // Terminal colours feed xterm.js and must stay plain hex on every theme.
      for (const k of TERMINAL_KEYS) {
        expect(theme.terminal[k], `terminal.${k}`).toSatisfy(isHex);
      }
      // Signature themes use translucent (rgba) chrome panels so the backdrop
      // breathes through; classic themes keep flat hex chrome.
      const uiOk = theme.group === "signature" ? (v: string) => isHex(v) || isRgba(v) : isHex;
      for (const k of UI_KEYS) {
        expect(theme.ui[k], `ui.${k}`).toSatisfy(uiOk);
      }
      expect(["light", "modern", "retro", "signature"]).toContain(theme.group);
    },
  );
});

describe("signature themes", () => {
  const signature = THEMES.filter((t) => t.group === "signature");

  it("ships the three signature themes", () => {
    expect(signature.map((t) => t.id)).toEqual(["deep-well", "aurora", "glass"]);
  });

  it("every signature theme carries a logo backdrop + window overlay; no classic theme does", () => {
    for (const t of THEMES) {
      if (t.group === "signature") {
        expect(t.backdrop, `${t.id}.backdrop`).toBeTruthy();
        expect(t.overlay, `${t.id}.overlay`).toBeTruthy();
      } else {
        expect(t.backdrop, `${t.id}.backdrop`).toBeUndefined();
        expect(t.overlay, `${t.id}.overlay`).toBeUndefined();
      }
    }
  });
});

describe("light themes", () => {
  it("ships at least one light theme", () => {
    expect(THEMES.some((t) => t.group === "light")).toBe(true);
  });
});

describe("themeSwatches", () => {
  it("returns six representative hex colors from the terminal palette", () => {
    const sw = themeSwatches(getTheme("nord"));
    expect(sw).toHaveLength(6);
    for (const c of sw) expect(c).toSatisfy(isHex);
    expect(sw[0]).toBe(getTheme("nord").terminal.background);
  });
});

// ── Secondary text reads on every theme ──────────────────────────────────────
//
// `muted` is the colour of everything that is not a row's main thing: labels,
// hints, icons — and data too (a log line's time, a file's size and owner).
// Taken from the schemes' "comment" colours it was 2.3–4:1 on 14 themes of 18:
// grey on black that was there to be read and could not be. The rule each
// palette is tuned to is spelled out on `UiPalette.muted`; this holds it.

/** WCAG AA for body text. */
const AA = 4.5;
/** `text` is at least this many times the contrast of `muted` — it must stay the brighter. */
const DIMMER = 1.15;
/** What `muted` is tuned to on a dark panel, and how far under a dim `text` it keeps. */
const LC_TARGET = 45;
const LC_UNDER_TEXT = 16;

/**
 * Schemes whose own text leaves no room for AA under it. `floor` is what the
 * scheme's tone gives; an entry that no longer excuses anything fails the test.
 */
const UNDER_AA: Record<string, { floor: number; why: string }> = {
  "solarized-dark": {
    floor: 4.1,
    why: "text is base1 at 4.9:1 on base02; muted is base0, the scheme's body tone",
  },
  "solarized-light": {
    floor: 3.6,
    why: "text is base01 at 4.4:1 on base2; muted is base00, the scheme's body tone",
  },
};

/**
 * APCA lightness contrast (Lc, as a magnitude) of text on a background —
 * APCA-W3 0.0.98G. Used next to the WCAG ratio because the ratio overstates
 * contrast on near-black surfaces: two greys both "4.5:1" read very differently
 * on `#0d131e` and on `#2e3440`.
 */
function lc(text: string, bg: string): number {
  const y = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.4);
    const v = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    return v > 0.022 ? v : v + (0.022 - v) ** 1.414;
  };
  const yt = y(text);
  const yb = y(bg);
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return s > -0.1 ? 0 : -(s + 0.027) * 100;
}

/** What is wrong with a theme's secondary text; empty when nothing is. */
function mutedProblems(theme: Pick<ThemeDef, "id" | "group" | "ui">): string[] {
  const { id, ui } = theme;
  const out: string[] = [];
  const floor = UNDER_AA[id]?.floor ?? AA;
  for (const [name, bg] of [
    ["panel", ui.panel],
    ["panelAlt", ui.panelAlt],
  ] as const) {
    const muted = contrastRatio(ui.muted, bg);
    const text = contrastRatio(ui.text, bg);
    if (muted === null || text === null) {
      out.push(`${id}: muted on ${name} cannot be measured — a colour is not plain hex`);
      continue;
    }
    if (muted < floor) out.push(`${id}: muted is ${muted.toFixed(2)}:1 on ${name}, under ${floor}`);
    if (text / muted < DIMMER) out.push(`${id}: muted is as bright as text on ${name}`);
    // Dark panels: the same perceived contrast everywhere, not the same ratio.
    if (theme.group !== "light" && !(id in UNDER_AA)) {
      const want = Math.min(LC_TARGET, lc(ui.text, bg) - LC_UNDER_TEXT);
      const got = lc(ui.muted, bg);
      if (got < want - 0.5) {
        out.push(`${id}: muted reads as Lc ${got.toFixed(0)} on ${name}, under ${want.toFixed(0)}`);
      }
    }
  }
  return out;
}

describe("secondary text (muted)", () => {
  it.each(THEMES.map((t) => [t.name, t] as const))("%s: reads, and stays dimmer than text", (_n, theme) => {
    expect(mutedProblems(theme)).toEqual([]);
  });

  it("an exception excuses a theme that is really under AA — and exists", () => {
    for (const [id, { why }] of Object.entries(UNDER_AA)) {
      const theme = THEMES.find((t) => t.id === id);
      expect(theme, `${id} is excused but is not a theme`).toBeDefined();
      const { ui } = theme!;
      const worst = Math.min(contrastRatio(ui.muted, ui.panel)!, contrastRatio(ui.muted, ui.panelAlt)!);
      expect(worst, `${id} reads at AA now — drop its excuse (${why})`).toBeLessThan(AA);
      // The reason given is true: the theme's own text has no room under it.
      const text = Math.min(contrastRatio(ui.text, ui.panel)!, contrastRatio(ui.text, ui.panelAlt)!);
      expect(text / DIMMER, id).toBeLessThan(AA);
    }
  });

  it("catches what it exists for", () => {
    const deepWell = getTheme("deep-well");
    const withMuted = (theme: ThemeDef, muted: string) => ({ ...theme, ui: { ...theme.ui, muted } });
    // The scheme's "comment" grey this replaced: 3.5:1 on the default theme.
    expect(mutedProblems(withMuted(deepWell, "#5f6b80"))).toEqual([
      "deep-well: muted is 3.46:1 on panel, under 4.5",
      "deep-well: muted reads as Lc 24 on panel, under 45",
      "deep-well: muted is 3.56:1 on panelAlt, under 4.5",
      "deep-well: muted reads as Lc 25 on panelAlt, under 45",
    ]);
    // Bare AA on a near-black panel passes the ratio and still reads faint.
    expect(mutedProblems(withMuted(deepWell, "#727f94"))).toEqual([
      "deep-well: muted reads as Lc 33 on panel, under 45",
      "deep-well: muted reads as Lc 33 on panelAlt, under 45",
    ]);
    // Lifted all the way to the text colour, it is no longer secondary.
    expect(mutedProblems(withMuted(deepWell, deepWell.ui.text))).toEqual([
      "deep-well: muted is as bright as text on panel",
      "deep-well: muted is as bright as text on panelAlt",
    ]);
    // An excused theme still has a floor of its own.
    const solarized = getTheme("solarized-dark");
    expect(mutedProblems(withMuted(solarized, "#586e75"))).toContain(
      "solarized-dark: muted is 2.42:1 on panelAlt, under 4.1",
    );
    // A colour that cannot be measured is not waved through.
    expect(mutedProblems(withMuted(deepWell, "rgba(138,151,173,1)"))).toHaveLength(2);
  });

  it("a light theme is held to AA, not to the dark panels' target", () => {
    const light = THEMES.filter((t) => t.group === "light");
    expect(light.length).toBeGreaterThan(0);
    for (const t of light) expect(mutedProblems(t)).toEqual([]);
    const github = getTheme("github-light");
    expect(mutedProblems({ ...github, ui: { ...github.ui, muted: "#8c959f" } })).toEqual([
      "github-light: muted is 3.04:1 on panel, under 4.5",
      "github-light: muted is 2.85:1 on panelAlt, under 4.5",
    ]);
  });
});

describe("first-paint tokens", () => {
  // app.css paints the first frame before any script runs; it has to be the
  // default theme, or the chrome changes colour as the app starts.
  it("app.css names the default theme's colours", () => {
    const css = readFileSync(join(process.cwd(), "src", "app.css"), "utf8");
    const theme = /@theme\s*\{([^]*?)\n\}/.exec(css)?.[1] ?? "";
    const token = (name: string) => new RegExp(`--color-${name}:\\s*([^;]+);`).exec(theme)?.[1];
    const ui = getTheme(DEFAULT_THEME_ID).ui;
    const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    // Every colour the palette names; what it leaves to the group default
    // (`statusPalette`) is not a first-paint promise of this theme.
    const named = Object.entries(ui).filter(([, v]) => typeof v === "string");
    expect(named.length).toBeGreaterThanOrEqual(UI_KEYS.length);
    for (const [key, value] of named) expect(token(kebab(key)), key).toBe(value);
  });
});

describe("default theme", () => {
  it("is Deep Well", () => {
    expect(DEFAULT_THEME_ID).toBe("deep-well");
    expect(getTheme(DEFAULT_THEME_ID).name).toBe("Deep Well");
  });
});

describe("getTheme", () => {
  it("returns the requested theme", () => {
    expect(getTheme("dracula").id).toBe("dracula");
  });
  it("falls back to the default for an unknown id", () => {
    expect(getTheme("does-not-exist").id).toBe(DEFAULT_THEME_ID);
  });
});

describe("applyUiPalette", () => {
  it("writes every UI color onto the document root as a CSS variable", () => {
    const ui = getTheme("nord").ui;
    applyUiPalette(ui);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-panel")).toBe(ui.panel);
    expect(style.getPropertyValue("--color-accent")).toBe(ui.accent);
    expect(style.getPropertyValue("--color-text")).toBe(ui.text);
    expect(style.getPropertyValue("--color-accent-hover")).toBe(ui.accentHover);
  });

  it("writes the status trio, using dark defaults by default", () => {
    applyUiPalette(getTheme("nord").ui);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-ok")).toBe(STATUS_DARK.ok);
    expect(style.getPropertyValue("--color-bad")).toBe(STATUS_DARK.bad);
  });

  it("writes light status defaults when the theme's panels are light", () => {
    applyUiPalette(getTheme("solarized-light").ui, true);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-ok")).toBe(STATUS_LIGHT.ok);
    expect(style.getPropertyValue("--color-warn")).toBe(STATUS_LIGHT.warn);
    expect(style.getPropertyValue("--color-bad")).toBe(STATUS_LIGHT.bad);
  });
});

describe("statusPalette", () => {
  const bare: UiPalette = {
    panel: "#000",
    panelAlt: "#000",
    edge: "#000",
    accent: "#000",
    accentHover: "#000",
    danger: "#000",
    muted: "#000",
    text: "#fff",
  };

  it("uses the dark trio for dark themes", () => {
    expect(statusPalette(bare, false)).toEqual({ ...STATUS_DARK });
  });

  it("uses a distinctly darker trio for light themes — the bug this replaced", () => {
    const light = statusPalette(bare, true);
    expect(light).toEqual({ ...STATUS_LIGHT });
    // The whole point: a light theme must NOT inherit the near-fluorescent
    // dark-theme values, which vanish on a cream panel.
    expect(light.ok).not.toBe(STATUS_DARK.ok);
    expect(light.warn).not.toBe(STATUS_DARK.warn);
    expect(light.bad).not.toBe(STATUS_DARK.bad);
  });

  it("lets a theme override any single colour and inherit the rest", () => {
    expect(statusPalette({ ...bare, warn: "#abcdef" }, false)).toEqual({
      ok: STATUS_DARK.ok,
      warn: "#abcdef",
      bad: STATUS_DARK.bad,
    });
  });

  it("every shipped light theme resolves to the light trio", () => {
    for (const t of THEMES.filter((x) => x.group === "light")) {
      const s = statusPalette(t.ui, true);
      expect(s.ok, t.id).not.toBe(STATUS_DARK.ok);
    }
  });
});
