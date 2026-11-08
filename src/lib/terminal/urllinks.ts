// Web addresses in terminal output (v1.20, non-Latin names since v1.35): which
// spans of a line are links, and the xterm provider that offers them.
//
// xterm's own URL addon matched the same pattern but then kept a match only if
// the parser's `scheme://host` was a prefix of the text — and the parser turns
// `пример.рф` into `xn--e1afmkfd.xn--p1ai`, so no address with a non-Latin name
// was ever a link. Here the text's own authority is parsed on its own and must
// read as the same host, user and password as the whole address does: the same
// guard against a parser that reads the start differently, without asking the
// text to be spelled in punycode. What the browser will connect to is the
// question dialog's to show (`linkTarget`, `idn`).
//
// Pure apart from the xterm types; the click goes to whatever `open` is — the
// terminal hands it to `clickLink` (termlink.guard).

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { lineText, logicalRows, spanRange } from "./termfiles";

/** How many rows a wrapped address may span and still be read. */
const MAX_WRAPPED_ROWS = 20;

// xterm's pattern, plus the quotation marks of Russian and other typography
// (`«https://x.ru»`) kept off the end: they close the sentence, not the address.
const URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`«»“”„]*[^\s"':,.!?{}|\\^~[\]`()<>«»“”„]/g;

/**
 * Whether the parser reads `text` as an http(s) address with the host, user
 * and password its own authority names — a non-Latin host included.
 */
export function isWebAddress(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // The parser takes `\` for `/`: what reads as `user\@host` goes elsewhere.
  if (text.includes("\\")) return false;
  const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(text)?.[1] ?? "";
  if (authority === "") return false;
  let base: URL;
  try {
    base = new URL(`${url.protocol}//${authority}`);
  } catch {
    return false;
  }
  return base.host === url.host && base.username === url.username && base.password === url.password;
}

/** The spans of `text` that are web addresses, left to right. */
export function findUrls(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (isWebAddress(m[0])) out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/** The part of xterm the provider uses — a fake one stands in for tests. */
export type UrlTerminal = Pick<Terminal, "buffer" | "cols">;

/** A provider that offers each address on the hovered line; a click calls `open`. */
export function createUrlLinks(term: UrlTerminal, open: (uri: string) => void): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const { first, rows } = logicalRows(term.buffer.active, bufferLineNumber - 1, MAX_WRAPPED_ROWS);
      const cols = term.cols;
      const line = lineText(rows, cols);
      const links: ILink[] = findUrls(line.text).map(({ from, to }) => ({
        range: spanRange(line, from, to, cols, first),
        text: line.text.slice(from, to),
        activate: (_event, uri) => open(uri),
      }));
      callback(links.length ? links : undefined);
    },
  };
}
