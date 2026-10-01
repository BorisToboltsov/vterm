// Small colour arithmetic on `#rgb`/`#rrggbb` strings (v1.0.42): mixing two
// colours and making one readable on a background. Used where a concrete colour
// must be computed in code — xterm and CodeMirror take colour strings, not CSS
// `color-mix` (prodtint.ts, cmtheme.ts). Pure; anything that isn't plain hex is
// passed through unchanged rather than guessed at.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Is `s` a colour these helpers understand? */
export function isHexColor(s: string): boolean {
  return HEX.test(s);
}

/** `#abc` / `#aabbcc` → [r, g, b], or null for anything else (rgba(), names…). */
function rgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` with `percent`% of `b` mixed in, as `#rrggbb`; `a` unchanged if either isn't hex. */
export function mixHex(a: string, b: string, percent: number): string {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a;
  const p = Math.min(Math.max(percent, 0), 100) / 100;
  return (
    "#" +
    x
      .map((v, i) => Math.round(v + (y[i] - v) * p))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** WCAG relative luminance of a hex colour (0 black … 1 white), or null. */
function luminance(hex: string): number | null {
  const c = rgb(hex);
  if (!c) return null;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two hex colours (1 … 21), or null if either isn't hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `color`, moved toward `toward` (the text colour) just far enough to reach
 * `min` contrast on `bg` — keeping its hue where it already reads. 4.5 is WCAG
 * AA for body text. Gives up at `toward` itself; non-hex input comes back as is.
 */
export function readableOn(color: string, bg: string, toward: string, min = 4.5): string {
  const start = contrastRatio(color, bg);
  if (start === null || start >= min || !isHexColor(toward)) return color;
  for (let p = 5; p <= 100; p += 5) {
    const c = mixHex(color, toward, p);
    if ((contrastRatio(c, bg) ?? 0) >= min) return c;
  }
  return mixHex(color, toward, 100);
}
