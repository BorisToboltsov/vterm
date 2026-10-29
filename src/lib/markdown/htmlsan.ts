// Allowlist HTML sanitiser for the markdown preview (Phase 44.6).
//
// Until now markdown.ts ESCAPED every raw HTML tag to text — a `<div align="center">`
// wrapping a README rendered as the literal string `<div align="center">`. That was
// a deliberate defence, not an oversight: the preview renders content we do not
// control (any .md opened over SFTP, LLM replies, notes), and the WebView holds
// `invoke()` access to every Tauri command, so one executed `<img onerror=…>` or
// `<a href=javascript:…>` is a full compromise.
//
// Rendering raw HTML therefore cannot mean "stop escaping" — it means "escape
// everything, then re-admit a fixed, safe subset". This module is that subset. It
// is opt-in (`MarkdownOptions.html`) and today only the editor's own preview turns
// it on; LLM/notes markdown stays fully escaped, because there is no reason to widen
// their surface. The sanitiser must nonetheless be correct on hostile input, since a
// .md on a compromised server is exactly that.
//
// What it admits, and nothing else:
//   * a fixed set of presentational tags (headings, lists, tables, text emphasis,
//     alignment wrappers, images) — everything else is dropped, tag only, children
//     kept;
//   * a fixed set of attributes per tag, each value re-validated (align against a
//     word list, dimensions against digits, href against the same scheme allowlist
//     as markdown links, src through the same image resolver as markdown images);
//   * NOTHING that can carry script or fetch on its own — no `on*`, no `style`
//     (which a CSP nonce would silently neuter in `tauri build` anyway, per the
//     CodeMirror trap in Phase 36.4), no `class`, no `data-*` (we mint our own
//     `data-md-link`), no `<script>/<style>/<iframe>/<object>/<svg>/…` (those are
//     dropped WITH their contents), no `srcset`/`<source>` (a remote fetch the
//     offline invariant forbids).
//
// Parsing is a hand-rolled tokeniser rather than the DOM, to keep this pure and
// unit-testable without a document (ADR 0003). Its bias is to DROP on any doubt: a
// tag it cannot parse cleanly becomes escaped text, never a half-built element.

/** Attributes admitted on every allowed tag (each value still re-validated below). */
const GLOBAL_ATTRS = ["align", "title", "dir", "lang"] as const;

/**
 * tag → the extra attributes it may carry beyond {@link GLOBAL_ATTRS}. Presence in
 * this map is what makes a tag allowed at all; the value lists only the additions.
 */
const TAG_ATTRS: Readonly<Record<string, readonly string[]>> = {
  // Block / structure.
  div: [],
  p: [],
  span: [],
  section: [],
  article: [],
  header: [],
  footer: [],
  main: [],
  center: [],
  figure: [],
  figcaption: [],
  details: [],
  summary: [],
  blockquote: ["cite"],
  pre: [],
  hr: [],
  br: [],
  // Headings.
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  // Lists.
  ul: [],
  ol: ["start", "type"],
  li: ["value"],
  dl: [],
  dt: [],
  dd: [],
  // Tables.
  table: ["width", "border", "cellpadding", "cellspacing"],
  caption: [],
  colgroup: ["span"],
  col: ["span", "width"],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: ["valign"],
  td: ["colspan", "rowspan", "valign", "width", "height"],
  th: ["colspan", "rowspan", "valign", "width", "height", "scope"],
  // Inline text.
  a: [], // href handled specially
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  strike: [],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  mark: [],
  small: [],
  sub: [],
  sup: [],
  kbd: [],
  samp: [],
  var: [],
  abbr: [],
  cite: [],
  q: ["cite"],
  code: [],
  time: ["datetime"],
  wbr: [],
  // Media (img handled specially; picture is a passthrough wrapper — its <source>
  // children are dropped, so only the <img> fallback shows and no srcset fetches).
  img: [],
  picture: [],
};

/** Void elements: emitted as a single tag, never expecting a close. */
const VOID = new Set(["br", "hr", "img", "col", "wbr"]);

/**
 * Tags dropped WITH everything up to their matching close. These can execute script
 * or fetch on their own, so leaving their text children (as the generic drop does)
 * would still surface `<script>`'s body as visible garbage at best.
 */
const DROP_TREE = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "link",
  "meta",
  "base",
  "head",
  "title",
  "frame",
  "frameset",
  "applet",
  "source", // srcset lives here — a remote fetch
]);

/** Block-level tags: a line that opens/closes one is a raw-HTML block, not a paragraph. */
const BLOCK = new Set([
  "div",
  "p",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "center",
  "figure",
  "figcaption",
  "details",
  "summary",
  "blockquote",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "picture",
]);

const ALIGN = new Set(["left", "right", "center", "justify", "start", "end"]);
const VALIGN = new Set(["top", "middle", "bottom", "baseline"]);
const DIR = new Set(["ltr", "rtl", "auto"]);
const SCOPE = new Set(["row", "col", "rowgroup", "colgroup"]);
const OL_TYPE = new Set(["1", "a", "A", "i", "I"]);

/** Escape text destined for element content. */
function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value destined for a double-quoted attribute. */
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

/**
 * Validate one attribute value for a given attribute name. Returns the string to
 * emit (already attribute-escaped) or null to drop the attribute. Unknown names
 * never reach here — the caller filters against the tag's allowlist first — so this
 * only has to police the values of names we DO admit.
 */
function attrValue(name: string, raw: string): string | null {
  const v = raw.trim();
  switch (name) {
    case "align":
      return ALIGN.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "valign":
      return VALIGN.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "dir":
      return DIR.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "scope":
      return SCOPE.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "type":
      return OL_TYPE.has(v) ? v : null;
    case "width":
    case "height":
      return /^\d{1,5}%?$/.test(v) ? v : null;
    case "colspan":
    case "rowspan":
    case "span":
    case "start":
    case "value":
    case "border":
    case "cellpadding":
    case "cellspacing":
      return /^\d{1,5}$/.test(v) ? v : null;
    // Free-text attributes: kept but escaped, so they can hold anything without
    // being able to break out of the quotes.
    case "title":
    case "lang":
    case "cite":
    case "datetime":
      return escAttr(v);
    default:
      return null;
  }
}

/**
 * Matches a single tag (open/close/self-closing) or an HTML comment at position 0.
 * The attribute run is `[^>]*` — everything up to the first `>` — deliberately
 * permissive: it means a malformed `<svg/onload=…>` is still recognised as an `svg`
 * tag and DROPPED, rather than slipping past as literal text. The cost is that an
 * attribute value legitimately containing `>` truncates the tag, which only ever
 * drops or shortens — it can never admit more than intended.
 */
const TAG_AT_START = /^<!--[\s\S]*?-->|^<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/;
/** Attribute scanner used inside a tag's attribute run. */
const ATTR_RE =
  /([a-zA-Z][a-zA-Z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

export interface HtmlCtx {
  /** A safe href for `<a>`, or null to render the anchor without one. */
  safeHref(url: string): string | null;
  /** Final HTML for an `<img>` — resolves to a data-URL image, badge or placeholder. */
  resolveImg(src: string, alt: string, dims: { width?: string; height?: string }): string;
  /** Stash a finished HTML fragment and return its placeholder token. */
  keep(html: string): string;
}

/** Parse a tag's attribute run into a lowercased name → value map (last wins). */
function parseAttrs(run: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of run.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** Build the sanitised open (or void) tag for an allowed element. */
function buildOpenTag(name: string, run: string, ctx: HtmlCtx): string {
  const attrs = parseAttrs(run);

  if (name === "img") {
    const src = attrs.get("src") ?? "";
    const alt = attrs.get("alt") ?? "";
    const width = attrValue("width", attrs.get("width") ?? "") ?? undefined;
    const height = attrValue("height", attrs.get("height") ?? "") ?? undefined;
    return ctx.resolveImg(src, alt, { width, height });
  }

  const allowed = new Set<string>([...GLOBAL_ATTRS, ...(TAG_ATTRS[name] ?? [])]);
  let out = `<${name}`;

  if (name === "a") {
    const href = ctx.safeHref(attrs.get("href") ?? "");
    if (href !== null) out += ` href="${escAttr(href)}"`;
    // Always tagged so the mdLinks action governs the click, href or not.
    out += " data-md-link";
  }

  for (const [aName, aRaw] of attrs) {
    if (aName === "href" && name === "a") continue; // handled above
    if (!allowed.has(aName)) continue;
    const val = attrValue(aName, aRaw);
    if (val === null) continue;
    out += ` ${aName}="${val}"`;
  }
  return `${out}>`;
}

/**
 * Protect the allowed HTML in `text`: every admitted tag becomes a placeholder
 * holding its sanitised form, dropped-tree elements vanish with their contents, and
 * a `<` that does not begin a parseable allowed/known tag is left as a literal `<`
 * for the caller to escape. Text between tags is returned untouched (the caller
 * escapes it), so markdown emphasis/links still apply to it.
 */
export function protectHtml(text: string, ctx: HtmlCtx): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, lt);
    const m = TAG_AT_START.exec(text.slice(lt));
    if (!m) {
      out += "<"; // a stray '<' (e.g. "a < b"); caller escapes it
      i = lt + 1;
      continue;
    }
    const whole = m[0];
    i = lt + whole.length;

    if (whole.startsWith("<!--")) continue; // comment: dropped

    const name = m[1].toLowerCase();
    const run = m[2] ?? "";
    const closing = whole[1] === "/";

    if (DROP_TREE.has(name)) {
      // Skip the element's whole subtree. Case-insensitive, tolerant of attributes
      // on the close tag; if unclosed, everything to the end goes.
      if (!closing && !whole.endsWith("/>")) {
        const close = new RegExp(`</${name}[\\s>]`, "i");
        const rest = text.slice(i);
        const cm = close.exec(rest);
        if (cm) {
          const gt = text.indexOf(">", i + cm.index);
          i = gt < 0 ? text.length : gt + 1;
        } else {
          i = text.length;
        }
      }
      continue;
    }

    if (!TAG_ATTRS[name]) continue; // known-but-not-allowed: drop tag, keep children

    if (closing) {
      out += VOID.has(name) ? "" : ctx.keep(`</${name}>`);
      continue;
    }
    out += ctx.keep(buildOpenTag(name, run, ctx));
  }
  return out;
}

/**
 * The block-level tag a line opens or closes, or null when the line is not a
 * standalone raw-HTML block. Used by the renderer to emit the line as HTML instead
 * of wrapping it in a `<p>`. Requires the line to START with the tag (leading
 * whitespace aside): `text <div>` is a paragraph that merely contains a tag.
 */
export function htmlBlockTag(line: string): string | null {
  const m = /^\s*<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(line);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return BLOCK.has(name) ? name : null;
}

/**
 * Every `src` of an admitted `<img>` in `html`, in order — the HTML counterpart of
 * markdown's `collectImages`, so raw-HTML images get pre-resolved too. Only real
 * `<img>` tags count; a `src` on some other element is not an image to load.
 */
export function collectHtmlImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b([^<>]*?)>/gi)) {
    const src = parseAttrs(m[1]).get("src");
    if (src) out.push(src);
  }
  return out;
}
