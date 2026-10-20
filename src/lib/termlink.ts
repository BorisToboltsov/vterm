// What a click on a web link in terminal output does (v1.20). Two kinds of link
// reach it: a URL the terminal found in the text (`WebLinksAddon`) — what is
// shown is what it leads to — and an OSC 8 hyperlink, whose text is whatever the
// program printed and whose target is set apart from it. A compromised host only
// has to print `github.com` over a link to somewhere else.
//
// Pure: which targets are links at all (http and https), which of them the app
// may open (https: the opener's capability allows nothing else), whether the
// click asks first, and how the address is shown in the question. The store
// (`stores/linkopen.svelte.ts`) acts on the answer; `LinkOpenDialog` draws it.

/** `settings.terminalLinks`: ask before opening, open right away, or never open. */
export const TERMINAL_LINK_MODES = ["confirm", "direct", "off"] as const;
export type TerminalLinkMode = (typeof TERMINAL_LINK_MODES)[number];
export const DEFAULT_TERMINAL_LINK_MODE: TerminalLinkMode = "confirm";

export const isTerminalLinkMode = (v: unknown): v is TerminalLinkMode =>
  typeof v === "string" && (TERMINAL_LINK_MODES as readonly string[]).includes(v);

/** A link target the app may hand to the system browser. */
export interface LinkTarget {
  /** The address as the browser will get it (normalized by the URL parser). */
  href: string;
  /** The host the browser will connect to — punycode for a non-Latin name. */
  host: string;
  /** The host is an internationalized name: its letters may imitate another's. */
  idn: boolean;
  /** https — the only scheme the opener's capability lets the app open. */
  openable: boolean;
}

/** `uri` as a link target, or null for anything but http(s) — never offered. */
export function linkTarget(uri: string): LinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  const host = url.hostname.toLowerCase();
  return {
    href: url.href,
    host,
    idn: host.split(".").some((label) => label.startsWith("xn--")),
    openable: url.protocol === "https:",
  };
}

/**
 * The address split around its host, so the host can stand out: `before` holds
 * the scheme and any `user@` (the old trick of putting a trusted name there),
 * `after` the port, path and query.
 */
export function addressParts(target: LinkTarget): { before: string; host: string; after: string } {
  const { href, host } = target;
  // The parser percent-encodes `@` and `/` inside the user part, so the host
  // starts after the last `@` of the authority, which ends at the path.
  const start = href.indexOf("//") + 2;
  const rest = href.slice(start);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const at = start + authority.lastIndexOf("@") + 1;
  // The fallback only keeps the address whole should the parser ever spell
  // the host differently in the two places.
  if (!href.startsWith(host, at)) return { before: href, host: "", after: "" };
  return { before: href.slice(0, at), host, after: href.slice(at + host.length) };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// A bare name reads as a site only with a dot and a final label of letters:
// `v1.2` is a version, `example.com` a site. A file name such as `notes.md`
// reads as a site too (`.md` is one) — that only makes such a link ask.
const BARE_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * The host the visible text of a link names, or null when the text does not
 * read as an address ("docs", "click here" claim no site).
 */
export function textHost(text: string): string | null {
  const s = text.trim();
  if (s === "" || /\s/.test(s)) return null;
  const candidate = SCHEME.test(s) ? s : BARE_HOST.test(s) ? `http://${s}` : null;
  if (candidate === null) return null;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

const site = (host: string): string => host.replace(/^www\./, "");

/**
 * The host an OSC 8 link's text claims, when it is not the host the link leads
 * to; null when the text claims none or the same one. Errs on the side of
 * asking: `docs.github.com` over `github.com` counts as another site.
 */
export function misleadingHost(text: string, target: LinkTarget): string | null {
  const shown = textHost(text);
  if (shown === null) return null;
  return site(shown) === site(target.host) ? null : shown;
}

/** The part of an xterm buffer `rangeText` reads. */
export interface TextBuffer {
  getLine(
    y: number,
  ): { translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined;
}

/** A buffer range as xterm hands it to a link handler: 1-based, end-inclusive. */
export interface CellRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** What the terminal shows over an OSC 8 link. */
export function rangeText(buf: TextBuffer, range: CellRange): string {
  let text = "";
  for (let y = range.start.y; y <= range.end.y; y++) {
    const from = y === range.start.y ? range.start.x - 1 : 0;
    const to = y === range.end.y ? range.end.x : undefined;
    text += buf.getLine(y - 1)?.translateToString(true, from, to) ?? "";
  }
  return text;
}

/** What the confirmation shows. */
export interface LinkQuestion {
  target: LinkTarget;
  /** The other host the link's text names, when it does. */
  shown: string | null;
  /** "Don't ask again" is offered: a misleading link asks in every mode, and
   *  one the app cannot open has nothing to stop asking about. */
  canSilence: boolean;
}

export type LinkAction =
  | { kind: "ignore" }
  | { kind: "open"; href: string }
  | { kind: "ask"; question: LinkQuestion };

/**
 * A click on a link: `uri` is where it leads, `text` what the terminal shows
 * for it — given only for an OSC 8 link, where the two can differ.
 */
export function linkClick(mode: TerminalLinkMode, uri: string, text?: string): LinkAction {
  if (mode === "off") return { kind: "ignore" };
  const target = linkTarget(uri);
  if (target === null) return { kind: "ignore" };
  const shown = text === undefined ? null : misleadingHost(text, target);
  const plain = shown === null && target.openable;
  if (mode === "direct" && plain) return { kind: "open", href: target.href };
  // An http link the app cannot open still asks: copying it is what is left.
  return { kind: "ask", question: { target, shown, canSilence: plain } };
}
