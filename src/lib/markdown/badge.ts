// Static shields.io badges, drawn locally (Phase 44.5).
//
// Phase 44.4 refused every remote image, badges included, and said so with a
// placeholder. For the badge row at the top of a README that is a poor answer to a
// question with a better one: a STATIC shields URL is a complete specification of
// the picture. `…/badge/version-0.44.4-blue` encodes label, message and colour and
// nothing else; shields.io is a pure function of that path, with no server-side
// state involved. Computing the same function here is not a guess about remote
// content — it IS the content, and no request is made.
//
// That argument is the whole feature, so the code must hold the line it draws:
//
//   * ONLY `/badge/<label>-<message>-<colour>` qualifies. A dynamic endpoint
//     (`/github/stars/o/r`, `/npm/v/pkg`, `/badge/dynamic/json?url=…`) reads its
//     message from an API at request time. We cannot know that value, so those
//     stay placeholders — inventing "1.2.3" because it looks like a version is
//     exactly the fake this codebase forbids elsewhere (fake connection
//     sub-stages, fake load-average on Windows).
//   * A colour that is not a shields name or a plain hex is refused rather than
//     defaulted, so nothing is drawn from a field we did not understand.
//
// Output is inline SVG rather than HTML with `style` attributes, and that is
// deliberate: `tauri build` stamps a per-load nonce into `style-src`, which by
// spec cancels `'unsafe-inline'` — a `style="background:#4c1"` would work in `dev`
// and silently lose every colour in the packaged app (the CodeMirror trap from
// Phase 36.4, one layer down). SVG `fill` is a presentation attribute, not a
// style, so CSP does not reach it and the badge looks the same in both builds.
//
// Rendering is approximate where shields is exact: text width comes from a
// character-class heuristic rather than real font metrics, `plastic`'s gradient is
// drawn flat, and `?logo=` is ignored (those icons are shields' own asset set). All
// three affect looks, none affects what the badge says.

/** Shields' named colours, as the hex they resolve to. */
const NAMED: Readonly<Record<string, string>> = {
  brightgreen: "#4c1",
  green: "#97ca00",
  yellow: "#dfb317",
  yellowgreen: "#a4a61d",
  orange: "#fe7d37",
  red: "#e05d44",
  blue: "#007ec6",
  grey: "#555",
  gray: "#555",
  lightgrey: "#9f9f9f",
  lightgray: "#9f9f9f",
  blueviolet: "#8a2be2",
  // Shields' semantic aliases.
  success: "#4c1",
  important: "#fe7d37",
  critical: "#e05d44",
  informational: "#007ec6",
  inactive: "#9f9f9f",
};

/** A plain hex colour, the only non-named form we accept into an SVG attribute. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The static-badge endpoint, and only it. */
const SHIELDS = /^https?:\/\/(?:img\.)?shields\.io\/badge\/(.+)$/i;

/** A parsed static badge — everything needed to draw it, nothing fetched. */
export interface StaticBadge {
  /** Left-hand caption; empty for the two-field `/badge/message-colour` form. */
  label: string;
  message: string;
  /** Right-hand fill, resolved to hex. */
  color: string;
  /** Left-hand fill, resolved to hex. */
  labelColor: string;
  /** `?style=flat-square`: square corners. */
  square: boolean;
  /** `?style=for-the-badge`: taller, bold, upper-cased. */
  caps: boolean;
}

/**
 * Undo the HTML escaping `inline()` applies before any tag is inserted. The badge
 * target reaches us already escaped, so a URL carrying `&` (query separators)
 * arrives as `&amp;` and would not parse. Only the three entities `escapeHtml`
 * produces are reversed — this is not a general entity decoder, and must not
 * become one: a decoder that understands `&#58;` would hand back the colon
 * `safeUrl` relies on never being reconstructed.
 */
function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Split shields' `label-message-colour` segment on single dashes, honouring `--`
 * as an escaped literal dash. Splitting with `String.split("-")` would cut
 * `flat--square` in half.
 */
function splitFields(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === "-") {
      if (seg[i + 1] === "-") {
        cur += "--"; // escaped dash, unwrapped below
        i++;
        continue;
      }
      out.push(cur);
      cur = "";
      continue;
    }
    cur += seg[i];
  }
  out.push(cur);
  return out;
}

// Sentinels for the escaped forms, so unwrapping `--` cannot re-consume a dash
// that the `_`→space pass just produced. Private-use code points, as in markdown.ts.
const DASH = "\uE001";
const UNDER = "\uE002";

/**
 * Decode one field the way shields documents it: `--` is a literal dash, `__` a
 * literal underscore, a lone `_` (or `%20`) a space. Percent-decoding comes LAST,
 * so a decoded `-` or `_` is text rather than re-read as syntax.
 */
function decodeField(f: string): string {
  const s = f
    .replace(/--/g, DASH)
    .replace(/__/g, UNDER)
    .replace(/_/g, " ")
    .replaceAll(DASH, "-")
    .replaceAll(UNDER, "_");
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed %-escape: keep the literal rather than dropping the badge
  }
}

/** Resolve a shields colour word or hex to hex, or null when we don't know it. */
export function badgeColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) return NAMED[s];
  if (HEX.test(s)) return s;
  // Shields accepts a bare hex without the `#`, which is what most READMEs use.
  if (HEX.test(`#${s}`)) return `#${s}`;
  return null;
}

/**
 * Parse a static shields.io badge URL, or null when the URL is anything else —
 * including every dynamic shields endpoint, whose message we cannot know without
 * asking a server.
 */
export function parseStaticBadge(url: string): StaticBadge | null {
  const m = SHIELDS.exec(unescapeHtml(url).trim());
  if (!m) return null;
  const [rawPath, rawQuery = ""] = m[1].split("?", 2);
  // `/badge/dynamic/json?url=…` wears the static prefix but reads a remote value.
  if (/^dynamic\//i.test(rawPath)) return null;
  const path = rawPath.replace(/\.(svg|png|json)$/i, "");

  const fields = splitFields(path).map(decodeField);
  let label = "";
  let message: string;
  let colorRaw: string;
  if (fields.length === 3) {
    [label, message, colorRaw] = fields;
  } else if (fields.length === 2) {
    [message, colorRaw] = fields;
  } else {
    return null;
  }

  const q = new URLSearchParams(rawQuery);
  const style = (q.get("style") ?? "").toLowerCase();
  const color = badgeColor(q.get("color") ?? colorRaw);
  if (!color) return null; // a field we did not understand is not drawn
  const labelColor = badgeColor(q.get("labelColor") ?? q.get("labelcolor") ?? "") ?? "#555";

  return {
    label,
    message,
    color,
    labelColor,
    square: style === "flat-square" || style === "square",
    caps: style === "for-the-badge",
  };
}

/** Escape text going into SVG markup (same five characters as XML). */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NARROW = "iljItf.,:;'|!()[]{}/\\-";
const WIDE = "WMmw@%";

/**
 * Approximate rendered width. Real badges measure glyphs against the font; we
 * classify characters instead, which lands within a few pixels for Latin text and
 * degrades gracefully for anything else (Cyrillic takes the default width).
 */
export function textWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) {
    if (NARROW.includes(ch)) w += 3.4;
    else if (WIDE.includes(ch)) w += 9.5;
    else if (ch >= "A" && ch <= "Z") w += 7.7;
    else w += 6.6;
  }
  return (w * fontSize) / 11;
}

/** Relative luminance, to pick text that is actually readable on the fill. */
function isLight(hex: string): boolean {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return false;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.66;
}

/**
 * Draw the badge as inline SVG.
 *
 * Rounded corners are done with an overlapping-rectangle trick rather than a
 * `clipPath`, because a clip path needs an `id` and several badges share one
 * document — colliding ids would make every badge on the page take the geometry of
 * the first one.
 */
export function badgeSvg(b: StaticBadge): string {
  const h = b.caps ? 28 : 20;
  const fontSize = b.caps ? 10 : 11;
  const pad = b.caps ? 9 : 5;
  const rx = b.square || b.caps ? 0 : 3;
  const label = b.caps ? b.label.toUpperCase() : b.label;
  const message = b.caps ? b.message.toUpperCase() : b.message;
  const track = b.caps ? 1.2 : 0; // letter-spacing, in px

  const lw = label ? Math.round(textWidth(label, fontSize) + track * label.length + pad * 2) : 0;
  const mw = Math.round(textWidth(message, fontSize) + track * message.length + pad * 2);
  const w = lw + mw;
  const alt = label ? `${label}: ${message}` : message;

  const text = (x: number, s: string, fill: string) =>
    `<text x="${x}" y="${h / 2}" dominant-baseline="central" text-anchor="middle" ` +
    `fill="${fill}" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" ` +
    `font-size="${fontSize}"${b.caps ? ' font-weight="bold" letter-spacing="1.2"' : ""}>` +
    `${esc(s)}</text>`;

  const parts = [
    // Whole badge in the message colour, rounded at both ends…
    `<rect width="${w}" height="${h}" rx="${rx}" fill="${b.color}"/>`,
  ];
  if (lw) {
    // …then the label over its left portion, plus a square patch that undoes the
    // rounding where the two halves meet.
    parts.push(`<rect width="${lw}" height="${h}" rx="${rx}" fill="${b.labelColor}"/>`);
    if (rx) parts.push(`<rect x="${lw - rx}" width="${rx}" height="${h}" fill="${b.labelColor}"/>`);
    parts.push(text(lw / 2, label, isLight(b.labelColor) ? "#333" : "#fff"));
  }
  parts.push(text(lw + mw / 2, message, isLight(b.color) ? "#333" : "#fff"));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="md-badge" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(alt)}">` +
    `<title>${esc(alt)}</title>${parts.join("")}</svg>`
  );
}

/**
 * SVG for a static badge URL, or null when the URL is not one — the single entry
 * point the markdown renderer uses.
 */
export function renderBadge(url: string): string | null {
  const b = parseStaticBadge(url);
  return b ? badgeSvg(b) : null;
}
