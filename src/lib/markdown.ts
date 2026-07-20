// Minimal, dependency-free Markdown → HTML renderer. Scope is intentionally
// limited to the constructs the project docs actually use: ATX headings, unordered
// lists, pipe tables, fenced/inline code, blockquotes, horizontal rules, links and
// bold/italic.
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
// The WebView holds `invoke()` access to every Tauri command (keychain, terminal
// writes, file I/O), so a single executed link is a full compromise — and the
// terminal output that reaches the model is, per the AI core prompt, explicitly
// untrusted data that may try to induce exactly such a link.

/** Escape the three characters that could otherwise inject markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** Render inline spans (code, links, bold, italic) from raw, unescaped text. */
export function inline(text: string): string {
  let out = escapeHtml(text);
  // Pull inline code out into placeholders so `**`/`[]`/`*` inside backticks
  // stay literal and aren't touched by the emphasis/link passes below.
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `${MARK}${codes.length - 1}${MARK}`;
  });
  // Links [label](url) → anchor tagged for the opener-intercepting click handler.
  // A target that fails the scheme allowlist is NOT rendered as an anchor at all:
  // the label stays as plain text. Emitting a dead `href="#"` would be worse — it
  // looks clickable, so the reader learns nothing about why it does nothing.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const href = safeUrl(String(url));
    if (href === null) return label;
    return `<a href="${href.replace(/"/g, "&quot;")}" data-md-link>${label}</a>`;
  });
  // Bold before italic so `**x**` is not mis-parsed as two italics.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
  // Restore the protected code spans.
  out = out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i) => codes[Number(i)]);
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^---+\s*$/;
const QUOTE = /^>\s?/;
const LIST = /^[-*]\s+(.*)$/;
const BLANK = /^\s*$/;

/** Is `line` the start of a new block (so a paragraph must stop before it)? */
function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    /^```/.test(line) ||
    BLANK.test(line)
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
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

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
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
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
      html.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
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
      for (const h of headers) t += `<th>${inline(h)}</th>`;
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>";
        for (const c of r) t += `<td>${inline(c)}</td>`;
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
      html.push(`<li>${inline(li[1])}</li>`);
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
    while (i < lines.length && !isBlockStart(lines[i])) buf.push(lines[i++]);
    html.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  closeList();
  return html.join("\n");
}
