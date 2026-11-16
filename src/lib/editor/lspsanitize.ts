// What a language server's hover and completion docs may put on the page
// (ADR 0079). The client renders the server's Markdown to HTML; the server is a
// program on a host we do not control, and the window holds `invoke()` to
// every command — so its HTML is untrusted input, like a README over SFTP. This
// is the same bias as `markdown/htmlsan.ts`, narrower: text tags and the
// highlighter's spans, no links, no images, no attribute but a class of plain
// tokens. A tokeniser, not the DOM; on any doubt the tag is dropped and its text
// kept, and script-like elements go with their contents.

/** Tags kept (without attributes, except `class` on the highlighter's tags). */
const KEEP = new Set([
  "p",
  "br",
  "hr",
  "code",
  "pre",
  "span",
  "div",
  "em",
  "strong",
  "b",
  "i",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "del",
  "sub",
  "sup",
]);

/** Elements that leave with everything inside them. */
const DROP_TREE = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "textarea", "select", "title", "xmp", "noembed", "noframes", "frameset", "frame", "applet", "head"]);

const CLASSED = new Set(["span", "code", "pre", "div"]);
const VOID = new Set(["br", "hr"]);

const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s<>"'=/]+(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'<>=`]+))?)*)\s*(\/?)>/;
const CLASS = /\sclass\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'<>=`]+))/i;

/** The class names a highlighter gives, plain tokens only. */
function safeClass(raw: string): string {
  return raw
    .split(/\s+/)
    .filter((c) => /^[\wͰ-Ͽ-]{1,40}$/.test(c))
    .slice(0, 8)
    .join(" ");
}

/** HTML a language server's Markdown became, reduced to what is safe to show. */
export function sanitizeLspHtml(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += escapeStray(html.slice(i));
      break;
    }
    out += escapeStray(html.slice(i, lt));
    const rest = html.slice(lt);
    if (rest.startsWith("<!--")) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const m = TAG.exec(rest);
    if (!m) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    const [whole, slash, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    i = lt + whole.length;
    if (DROP_TREE.has(name)) {
      if (!slash) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        if (close < 0) {
          i = html.length;
        } else {
          const gt = html.indexOf(">", close);
          i = gt < 0 ? html.length : gt + 1;
        }
      }
      continue;
    }
    if (!KEEP.has(name)) continue;
    if (slash) {
      if (!VOID.has(name)) out += `</${name}>`;
      continue;
    }
    let cls = "";
    if (CLASSED.has(name)) {
      const c = CLASS.exec(attrs);
      const value = c ? safeClass(c[1] ?? c[2] ?? c[3] ?? "") : "";
      if (value) cls = ` class="${value}"`;
    }
    out += `<${name}${cls}>`;
  }
  return out;
}

/** A `>` or a quote outside a tag is text; entities the renderer wrote stay as they are. */
function escapeStray(text: string): string {
  return text.replace(/>/g, "&gt;");
}
