// Minimal, dependency-free Markdown → HTML renderer. Scope is intentionally
// limited to the constructs the project docs actually use: ATX headings, unordered
// lists, pipe tables, fenced/inline code, blockquotes, horizontal rules, links,
// images and bold/italic.
//
// Images (Phase 44.4) are rendered only from a `data:` URL the caller resolved
// beforehand and passed in `MarkdownOptions.images`; everything else becomes a
// placeholder — except a static shields.io badge, which Phase 44.5 draws from its
// own URL (badge.ts), because that URL already contains the whole picture.
// The renderer stays synchronous and pure — the fetching that fills
// that map is the caller's job, and `mdimage.ts` holds the rules about which
// targets can be fetched at all. Before this, `![alt](src)` matched no image rule
// at all: the `!` survived as literal text and the rest fell into the link pass,
// so a README's badge row rendered as `!` plus a clickable label.
//
// INPUT IS UNTRUSTED (Phase 44.3). This module was written for one caller — the
// bundled manual (`docs/GUIDE.md?raw`) — and its header used to say so. It has
// since grown four more callers that feed it content we do not control: LLM replies
// (AiChat), AI-generated plans (RecordingsPanel), any .md opened over SFTP
// (EditorTab) and user notes (NotesModal). Treat every caller as hostile.
//
// Two defences, and BOTH are required:
//   1. Text is HTML-escaped before any tag is inserted (`escapeHtml`), and link
//      targets go through `safeUrl` — a scheme allowlist. Escaping alone is not
//      enough: `[x](javascript:…)` injects no markup at all, it just becomes the
//      `href` of an anchor we built ourselves.
//   2. Callers MUST mount the rendered HTML under `use:mdLinks`
//      (actions/mdlinks.ts), which intercepts clicks and routes http(s) to the
//      system browser instead of navigating the WebView. Enforced by
//      mdlink.guard.test.ts.
//
// Raw HTML (Phase 44.6) does NOT relax rule 1: with `opts.html` a caller admits a
// fixed, sanitised subset of tags (htmlsan.ts) — everything is still escaped first,
// then the allowlist is re-admitted. It is opt-in and off for LLM/notes; see
// `MarkdownOptions.html`.
// The WebView holds `invoke()` access to every Tauri command (keychain, terminal
// writes, file I/O), so a single executed link is a full compromise — and the
// terminal output that reaches the model is, per the AI core prompt, explicitly
// untrusted data that may try to induce exactly such a link.

import { renderBadge } from "./badge";
import { collectHtmlImages, htmlBlockTag, protectHtml } from "./htmlsan";

/** Escape the three characters that could otherwise inject markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Heading slug for in-page anchors — the bundled manual's table of contents links
 * to these, and `mdLinks` scrolls to the matching heading `id`. Keeps Unicode
 * letters/digits (so Cyrillic headings get readable, GitHub-ish ids), drops emoji
 * and punctuation, spaces → hyphens. The charset is deliberately narrow: the result
 * goes straight into an `id`/`href` attribute, and letters+digits+hyphen contain
 * nothing that could break out of it.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Schemes a markdown link may carry. `http(s)` is handed to the system browser by
// the mdLinks action; `mailto` to the OS handler. Everything else — `javascript:`,
// `data:`, `vbscript:`, `file:`, custom app schemes — is refused.
const ALLOWED_SCHEME = /^(?:https?|mailto):/i;
// A scheme is the run of chars before the first `:`, provided no `/`, `?` or `#`
// comes first (otherwise the colon belongs to a path/query, e.g. `a/b:c`).
const HAS_SCHEME = /^[^/?#]*:/;

/**
 * Validate a markdown link target. Returns the URL when it is safe to put in an
 * `href`, or `null` when the link must not be rendered as a link at all.
 *
 * Allowed: absolute http(s)/mailto, and scheme-less relative targets (the repo
 * links in the bundled manual). Refused: any other scheme, and protocol-relative
 * `//host` — which is not a relative path but a navigation off to another origin.
 *
 * Leading control characters and whitespace are stripped before the check because
 * browsers ignore them when resolving a scheme: `java\tscript:` runs as
 * `javascript:`. Entity-encoded colons (`javascript&#58;x`) need no handling here —
 * `escapeHtml` has already turned their `&` into `&amp;`, so the parser never
 * decodes them back into a scheme.
 */
export function safeUrl(url: string): string | null {
  const trimmed = url.replace(/[\u0000-\u0020]/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  if (HAS_SCHEME.test(trimmed)) return ALLOWED_SCHEME.test(trimmed) ? url.trim() : null;
  return url.trim();
}

// Sentinel wrapping a protected-code-span index. Uses a private-use code point
// that never appears in markdown source, so the restore pass can't collide with
// real text (e.g. digits surrounded by spaces).
const MARK = "\uE000";

/** Quote-escape a value going into an HTML attribute (text is already escaped). */
function attr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

/** Images, matched before links so `[![badge](img)](href)` parses as a linked image. */
const IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Drop the optional title from a link/image target: `(url "alt text")`. Without
 * this the title travels into the `href`/`src` and nothing resolves. Only a
 * fully-quoted trailing group is stripped, so a target that merely contains a
 * space is left exactly as it was.
 */
export function splitTarget(raw: string): string {
  const t = raw.trim();
  const m = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(t);
  return m ? m[1] : t;
}

/** Options threaded through the renderer. */
export interface MarkdownOptions {
  /**
   * Resolved images, keyed by the raw markdown target. A target that is absent —
   * which is every target for callers that pass nothing — renders as a
   * placeholder instead of an `<img>`; see `mdimage.ts` for why most of them
   * cannot be loaded at all.
   */
  images?: ReadonlyMap<string, string>;
  /**
   * Admit a safe subset of raw HTML (`<div align="center">`, `<sub>`, `<kbd>`,
   * tables…) instead of escaping it to text. OFF by default and opt-in per caller:
   * only the editor's file preview turns it on. LLM replies and notes stay fully
   * escaped — there is no reason to widen their surface, and the sanitiser
   * (htmlsan.ts) is the app's, not theirs, to trust. The subset is safe on hostile
   * input regardless, because a preview target can be a .md on a compromised server.
   */
  html?: boolean;
}

/**
 * Only a `data:` image may reach an `<img src>`. The map is filled by EditorTab
 * from bytes it just read, so this looks redundant — it is not: the check lives
 * here so no future caller can make `renderMarkdown` emit a src it did not vet,
 * exactly as `safeUrl` guards `href` independently of the mdLinks action.
 */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i;

/**
 * Final HTML for one image target — a static badge drawn from its URL, a resolved
 * `data:` image, or the honest placeholder. Shared by the markdown `![]()` pass and
 * the raw-HTML `<img>` sanitiser so both obey the same rules. `alt` is expected
 * ALREADY HTML-escaped (the markdown pass runs post-escape; the HTML sanitiser
 * escapes it before calling). `dims` come only from raw HTML and are pre-checked by
 * htmlsan, so they are emitted verbatim.
 */
function imageHtml(
  raw: string,
  alt: string,
  opts: MarkdownOptions | undefined,
  dims?: { width?: string; height?: string },
): string {
  const badge = renderBadge(raw);
  if (badge) return badge;
  const src = opts?.images?.get(raw);
  if (src && DATA_IMAGE.test(src)) {
    const w = dims?.width ? ` width="${dims.width}"` : "";
    const h = dims?.height ? ` height="${dims.height}"` : "";
    return `<img src="${attr(src)}" alt="${attr(alt)}"${w}${h} loading="lazy">`;
  }
  // Not an `<img>` with a dead src: a broken-image icon says "this file is damaged",
  // a lie about an image (a badge, a remote screenshot) that simply cannot load here.
  return `<span class="md-img" data-md-src="${attr(raw)}">${alt}</span>`;
}

/** Render inline spans (code, HTML, images, links, bold, italic) from raw text. */
export function inline(text: string, opts?: MarkdownOptions): string {
  // Leaf HTML (code spans, images, sanitised tags) is stashed as placeholders so
  // the escape/emphasis/link passes below cannot touch it; links are emitted inline
  // (never stashed), which keeps restore a single, non-nesting pass — the badge
  // idiom `[![alt](img)](href)` works because only the image leaf is a placeholder.
  const codes: string[] = [];
  const keep = (html: string) => `${MARK}${codes.push(html) - 1}${MARK}`;

  let out = text;
  // Inline code first, from raw text, so `**`/`[]`/`*`/`<` inside backticks stay
  // literal and are escaped as code content, not parsed.
  out = out.replace(/`([^`]+)`/g, (_m, c) => keep(`<code>${escapeHtml(c)}</code>`));
  // Raw HTML (opt-in), also before escaping: admitted tags become placeholders,
  // disallowed ones are dropped, and text between them stays raw to be escaped next.
  if (opts?.html) {
    out = protectHtml(out, {
      safeHref: safeUrl,
      resolveImg: (src, alt, dims) => imageHtml(splitTarget(src), escapeHtml(alt), opts, dims),
      keep,
    });
  }
  // Escape everything still raw (stray `<>&`, and the alt/url of markdown syntax).
  out = escapeHtml(out);
  // Images: the same placeholder table keeps alt out of the emphasis pass and
  // leaves a bracket-free marker, so the link regex (`[^\]]+`) can still match the
  // badge idiom `[![alt](img)](href)`. alt/url are escaped here, so imageHtml gets
  // escaped text — its own re-escape is idempotent on that.
  out = out.replace(IMAGE, (_m, alt: string, target: string) =>
    keep(imageHtml(splitTarget(target), alt, opts)),
  );
  // Links [label](url) → anchor tagged for the opener-intercepting click handler.
  // A target that fails the scheme allowlist is NOT rendered as an anchor at all:
  // the label stays as plain text. A dead `href="#"` would be worse — it looks
  // clickable, so the reader learns nothing about why it does nothing.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const href = safeUrl(splitTarget(String(url)));
    if (href === null) return label;
    return `<a href="${attr(href)}" data-md-link>${label}</a>`;
  });
  // Bold before italic so `**x**` is not mis-parsed as two italics.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
  // Restore the protected leaves (single pass; placeholders never nest).
  out = out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i) => codes[Number(i)]);
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^---+\s*$/;
const QUOTE = /^>\s?/;
const LIST = /^[-*]\s+(.*)$/;
const BLANK = /^\s*$/;

/** Is `line` the start of a new block (so a paragraph must stop before it)? */
function isBlockStart(line: string, html: boolean): boolean {
  return (
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    /^```/.test(line) ||
    BLANK.test(line) ||
    (html && htmlBlockTag(line) !== null)
  );
}

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Convert a Markdown string into an HTML fragment. */
export function renderMarkdown(md: string, opts?: MarkdownOptions): string {
  const htmlOn = opts?.html === true;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let inList = false;
  // Track emitted heading ids so repeated headings get unique anchors (`git`,
  // `git-2`) — a duplicate id is invalid HTML and would jump to the wrong section.
  const usedIds = new Set<string>();
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Raw-HTML comment block (opt-in): swallow it, across lines if needed. A README
    // commonly parks unfinished markup in `<!-- … -->`; escaping it to visible text
    // is exactly the "renders as literal tags" complaint this phase fixes.
    if (htmlOn && /^\s*<!--/.test(line)) {
      closeList();
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++; // consume the line holding `-->` (or step off the end)
      continue;
    }

    // Raw-HTML block line (opt-in): a line that opens/closes a block-level element
    // (`<div align="center">`, `</div>`, a `<table>` row…) is emitted as sanitised
    // HTML, NOT wrapped in a <p>. Inner markdown on its own lines renders normally,
    // so `<div align="center">` … `</div>` centres the markdown between them.
    if (htmlOn && htmlBlockTag(line) !== null) {
      closeList();
      html.push(inline(line, opts));
      i++;
      continue;
    }

    // Fenced code block.
    if (/^```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      html.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const base = slugify(heading[2]);
      let attr = "";
      if (base) {
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
        usedIds.add(id);
        attr = ` id="${id}"`;
      }
      html.push(`<h${level}${attr}>${inline(heading[2], opts)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      closeList();
      html.push("<hr>");
      i++;
      continue;
    }

    // Blockquote — collapse consecutive `>` lines into one quote.
    if (QUOTE.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(QUOTE, ""));
      html.push(`<blockquote>${inline(buf.join(" "), opts)}</blockquote>`);
      continue;
    }

    // Pipe table: a header row followed by a `---|---` separator row.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("-") &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      closeList();
      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) rows.push(parseRow(lines[i++]));
      let t = "<table><thead><tr>";
      for (const h of headers) t += `<th>${inline(h, opts)}</th>`;
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>";
        for (const c of r) t += `<td>${inline(c, opts)}</td>`;
        t += "</tr>";
      }
      html.push(t + "</tbody></table>");
      continue;
    }

    const li = LIST.exec(line);
    if (li) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(li[1], opts)}</li>`);
      i++;
      continue;
    }

    if (BLANK.test(line)) {
      closeList();
      i++;
      continue;
    }

    // Paragraph — gather consecutive plain lines.
    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i], htmlOn)) buf.push(lines[i++]);
    html.push(`<p>${inline(buf.join(" "), opts)}</p>`);
  }

  closeList();
  return html.join("\n");
}

/**
 * Every distinct image target in `md`, in source order — what a caller must
 * resolve before re-rendering with `opts.images` (see `mdimage.ts`).
 *
 * Code is skipped, both fenced and inline, for the same reason the renderer skips
 * it: a target inside backticks is being *discussed*, not displayed. Collecting it
 * anyway would make the preview read a file the document merely names — a small
 * thing, but it is the difference between showing what a document contains and
 * acting on what it says.
 */
export function collectImages(md: string): string[] {
  const found = new Set<string>();
  let fenced = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bare = line.replace(/`[^`]+`/g, "");
    for (const m of bare.matchAll(IMAGE)) found.add(splitTarget(m[2]));
    // Raw-HTML `<img src>` targets too, so the preview pre-resolves them like
    // markdown images. Harmless when html rendering is off — a `<img>` left as
    // escaped text is simply never re-scanned as a tag.
    for (const src of collectHtmlImages(bare)) found.add(splitTarget(src));
  }
  return [...found];
}
