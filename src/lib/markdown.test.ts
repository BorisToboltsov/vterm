import { describe, expect, it } from "vitest";
import { escapeHtml, inline, renderMarkdown } from "./markdown";

describe("escapeHtml", () => {
  it("escapes the markup-significant characters", () => {
    expect(escapeHtml('<title> & "x"')).toBe('&lt;title&gt; &amp; "x"');
  });
});

describe("inline", () => {
  it("renders code, bold, italic and links", () => {
    expect(inline("a `b` c")).toBe("a <code>b</code> c");
    expect(inline("**bold**")).toBe("<strong>bold</strong>");
    expect(inline("an *em* word")).toBe("an <em>em</em> word");
  });
  it("turns links into anchors tagged for the opener", () => {
    expect(inline("[Tauri](https://tauri.app)")).toBe(
      '<a href="https://tauri.app" data-md-link>Tauri</a>',
    );
  });
  it("escapes HTML inside text before adding tags", () => {
    expect(inline("x <b> y")).toBe("x &lt;b&gt; y");
  });
  it("keeps backticked content literal (no bold inside code)", () => {
    expect(inline("`**not bold**`")).toBe("<code>**not bold**</code>");
  });
});

describe("renderMarkdown", () => {
  it("renders headings by level", () => {
    expect(renderMarkdown("# H1")).toContain("<h1>H1</h1>");
    expect(renderMarkdown("### H3")).toContain("<h3>H3</h3>");
  });

  it("groups consecutive list items into one <ul>", () => {
    const html = renderMarkdown("- a\n- b\n- c");
    expect(html).toBe("<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ul>");
  });

  it("renders fenced code blocks with escaped content", () => {
    const html = renderMarkdown("```\n<title>x</title>\n```");
    expect(html).toBe("<pre><code>&lt;title&gt;x&lt;/title&gt;</code></pre>");
  });

  it("renders a pipe table", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(renderMarkdown("> note\n> more")).toBe("<blockquote>note more</blockquote>");
    expect(renderMarkdown("---")).toBe("<hr>");
  });

  it("wraps plain text in a paragraph and joins wrapped lines", () => {
    expect(renderMarkdown("hello\nworld")).toBe("<p>hello world</p>");
  });

  it("does not confuse a list dash with a horizontal rule", () => {
    expect(renderMarkdown("- item")).toBe("<ul>\n<li>item</li>\n</ul>");
  });

  it("closes an open list before a following heading", () => {
    const html = renderMarkdown("- a\n# Title");
    expect(html).toBe("<ul>\n<li>a</li>\n</ul>\n<h1>Title</h1>");
  });
});
