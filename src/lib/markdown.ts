// Minimal, dependency-free Markdown → HTML renderer used to show the bundled
// README inside the in-app manual (Help → Инструкция). Scope is intentionally
// limited to the constructs the project docs actually use: ATX headings, unordered
// lists, pipe tables, fenced/inline code, blockquotes, horizontal rules, links and
// bold/italic. All text is HTML-escaped before any tag is inserted, so the output
// is safe for `{@html …}` — and the only input is our own trusted markdown that
// Vite bundles at build time (`?raw`), never user content.

/** Escape the three characters that could otherwise inject markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const safeUrl = String(url).replace(/"/g, "&quot;");
    return `<a href="${safeUrl}" data-md-link>${label}</a>`;
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
