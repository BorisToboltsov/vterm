import { describe, expect, it } from "vitest";
import { collectHtmlImages, htmlBlockTag, protectHtml, type HtmlCtx } from "./htmlsan";
import { inline, renderMarkdown } from "./markdown";

// The sanitiser (Phase 44.6) admits a fixed HTML subset into the preview. The
// preview renders content we do not control and the WebView can `invoke()` every
// Tauri command, so the tests that matter most are the ones proving hostile markup
// never survives. Most are driven through `inline(x, {html:true})` — the real
// integration — rather than the sanitiser in isolation.
const html = (s: string) => inline(s, { html: true });

describe("admits a safe subset", () => {
  it("keeps alignment wrappers, so <div align> can center a README", () => {
    expect(html('<div align="center">')).toBe('<div align="center">');
    expect(html("</div>")).toBe("</div>");
    expect(html('<p align="right">')).toBe('<p align="right">');
  });

  it("keeps common inline formatting tags", () => {
    expect(html("H<sub>2</sub>O")).toBe("H<sub>2</sub>O");
    expect(html("x<sup>2</sup>")).toBe("x<sup>2</sup>");
    expect(html("<kbd>Ctrl</kbd>")).toBe("<kbd>Ctrl</kbd>");
    expect(html("a<br>b")).toBe("a<br>b");
  });

  it("still applies markdown emphasis to text around tags", () => {
    expect(html("<div>**bold**</div>")).toBe("<div><strong>bold</strong></div>");
  });

  it("escapes text content between tags", () => {
    expect(html("<div>a < b & c</div>")).toBe("<div>a &lt; b &amp; c</div>");
  });
});

describe("refuses everything dangerous", () => {
  it("drops <script> together with its contents", () => {
    expect(html("<script>alert(1)</script>")).toBe("");
    expect(html("a<script>alert(1)</script>b")).toBe("ab");
    expect(html("<script src='//evil'></script>")).toBe("");
  });

  it("drops an UNCLOSED dropped-tree element to the end of input", () => {
    // No matching close: everything from the open tag on is gone, not left dangling.
    expect(html("keep<script>alert(1) and more")).toBe("keep");
    expect(html("<style>*{x:1}")).toBe("");
  });

  it("treats a self-closed dropped-tree tag as just that tag", () => {
    // `<svg/>` closes itself, so following content is NOT swallowed as its subtree.
    expect(html("<svg/>after")).toBe("after");
  });

  it("drops <style>, <iframe>, <object>, <svg>, <form> and their contents", () => {
    expect(html("<style>*{x:1}</style>")).toBe("");
    expect(html("<iframe src='//evil'></iframe>")).toBe("");
    expect(html("<object data='x'></object>")).toBe("");
    expect(html("<svg><script>x</script></svg>")).toBe("");
    expect(html("<form action='//evil'><input></form>")).toBe("");
  });

  it("strips event handlers while keeping the element", () => {
    expect(html('<div onclick="steal()">hi</div>')).toBe("<div>hi</div>");
    expect(html('<a href="https://x.test" onmouseover="x">t</a>')).toBe(
      '<a href="https://x.test" data-md-link>t</a>',
    );
  });

  it("strips style, class and data-* attributes", () => {
    expect(html('<div style="position:fixed" class="app" data-x="y">t</div>')).toBe("<div>t</div>");
  });

  it("refuses a javascript: (and other unsafe) href, keeping the anchor inert", () => {
    // Same allowlist as markdown links; a dead but tagged anchor lets mdLinks
    // govern the click, and carries no href to act on.
    expect(html('<a href="javascript:alert(1)">x</a>')).toBe("<a data-md-link>x</a>");
    expect(html('<a href="vbscript:x">x</a>')).toBe("<a data-md-link>x</a>");
    expect(html('<a href="https://ok.test">x</a>')).toBe(
      '<a href="https://ok.test" data-md-link>x</a>',
    );
  });

  it("drops an unknown tag but keeps its children", () => {
    expect(html("<marquee>run</marquee>")).toBe("run");
    expect(html("<font color=red>t</font>")).toBe("t");
    expect(html("<blink>t</blink>")).toBe("t");
  });

  it("drops HTML comments (a stray one, at least)", () => {
    expect(html("a<!-- secret -->b")).toBe("ab");
  });

  it("leaves a stray < as escaped text, never a half-built tag", () => {
    expect(html("a < b")).toBe("a &lt; b");
    expect(html("3 <4 and 5> 2")).toBe("3 &lt;4 and 5&gt; 2");
  });

  it("never emits a dangerous construct for a battery of hostile inputs", () => {
    const hostile = [
      '<img src=x onerror="invoke()">',
      '<a href="  javascript:alert(1)">x</a>',
      '<DIV ONCLICK="x">t</DIV>',
      "<scr<script>ipt>alert(1)</script>",
      '<div style="background:url(javascript:x)">t</div>',
      '<svg/onload="x">',
      '<a href="java\tscript:x">t</a>',
      "<iframe srcdoc='<script>x</script>'>",
    ];
    for (const h of hostile) {
      const out = html(h);
      const low = out.toLowerCase();
      // No live handler attribute (an escaped mention in inert text is fine, so we
      // look for the `on…=` attribute shape, not the bare word).
      expect(low).not.toMatch(/\son\w+=/);
      expect(low).not.toContain("javascript:");
      expect(low).not.toContain("<script");
      expect(low).not.toContain("<svg");
      expect(low).not.toContain("<iframe");
      expect(out).not.toContain("style=");
    }
  });
});

describe("attribute value validation", () => {
  it("keeps align only from the word list", () => {
    expect(html('<div align="center">')).toBe('<div align="center">');
    expect(html('<div align="url(x)">')).toBe("<div>"); // rejected value dropped
    expect(html('<div align="CENTER">')).toBe('<div align="center">'); // normalised
  });

  it("keeps width/height only when they are plain dimensions", () => {
    expect(html('<td width="120">')).toBe('<td width="120">');
    expect(html('<td width="50%">')).toBe('<td width="50%">');
    expect(html('<td width="1e9; expression(x)">')).toBe("<td>");
  });

  it("keeps colspan only as digits", () => {
    expect(html('<td colspan="2">')).toBe('<td colspan="2">');
    expect(html('<td colspan="2 foo">')).toBe("<td>");
  });

  it("escapes free-text title values", () => {
    // A `"`, `&` or `<` inside the value cannot break out of the quotes.
    expect(html('<abbr title=\'a "b" & <c\'>x</abbr>')).toBe(
      '<abbr title="a &quot;b&quot; &amp; &lt;c">x</abbr>',
    );
  });

  it("policies the other enumerated attributes against their word lists", () => {
    expect(html('<td valign="top">')).toBe('<td valign="top">');
    expect(html('<td valign="sideways">')).toBe("<td>");
    expect(html('<span dir="rtl">')).toBe('<span dir="rtl">');
    expect(html('<span dir="sideways">')).toBe("<span>");
    expect(html('<th scope="col">')).toBe('<th scope="col">');
    expect(html('<th scope="planet">')).toBe("<th>");
    expect(html('<ol type="a">')).toBe('<ol type="a">');
    expect(html('<ol type="emoji">')).toBe("<ol>");
    expect(html('<ol start="3">')).toBe('<ol start="3">');
  });
});

describe("images from raw HTML", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("resolves <img src> through the same path as markdown images", () => {
    expect(inline('<img src="a.png" alt="shot">', { html: true, images: new Map([["a.png", png]]) })).toBe(
      `<img src="${png}" alt="shot" loading="lazy">`,
    );
  });

  it("draws a static badge from an <img> pointing at shields", () => {
    expect(inline('<img src="https://img.shields.io/badge/a-b-blue">', { html: true })).toContain(
      "<svg",
    );
  });

  it("passes validated width/height onto a resolved image", () => {
    const out = inline('<img src="a.png" alt="s" width="600" height="20">', {
      html: true,
      images: new Map([["a.png", png]]),
    });
    expect(out).toContain('width="600"');
    expect(out).toContain('height="20"');
  });

  it("shows the placeholder for an unresolved <img>, escaping its alt", () => {
    expect(inline('<img src="x.png" alt="a & b">', { html: true })).toBe(
      '<span class="md-img" data-md-src="x.png">a &amp; b</span>',
    );
  });
});

describe("htmlBlockTag", () => {
  it("names the block element a line opens or closes", () => {
    expect(htmlBlockTag('<div align="center">')).toBe("div");
    expect(htmlBlockTag("</div>")).toBe("div");
    expect(htmlBlockTag("  <table>")).toBe("table");
    expect(htmlBlockTag("<tr><td>a</td></tr>")).toBe("tr");
  });

  it("returns null for inline-only or non-HTML lines", () => {
    expect(htmlBlockTag("<sub>2</sub>")).toBeNull(); // sub is inline
    expect(htmlBlockTag("text <div>")).toBeNull(); // must START with the tag
    expect(htmlBlockTag("just prose")).toBeNull();
    expect(htmlBlockTag("<https://autolink>")).toBeNull();
  });
});

describe("collectHtmlImages", () => {
  it("finds every <img src>, ignoring src on other elements", () => {
    expect(collectHtmlImages('<img src="a.png"> text <img src=\'b.png\'>')).toEqual([
      "a.png",
      "b.png",
    ]);
    expect(collectHtmlImages('<source src="x.png">')).toEqual([]);
  });
});

describe("renderMarkdown block-level HTML", () => {
  it("emits a block HTML line raw instead of wrapping it in <p>", () => {
    const out = renderMarkdown('<div align="center">\n\n# Title\n\n</div>', { html: true });
    expect(out).toContain('<div align="center">');
    expect(out).toContain('<h1 id="title">Title</h1>');
    expect(out).toContain("</div>");
    expect(out).not.toContain("<p><div");
  });

  it("swallows a multi-line HTML comment block", () => {
    const out = renderMarkdown("before\n\n<!--\nhidden\n-->\n\nafter", { html: true });
    expect(out).not.toContain("hidden");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  it("still escapes raw HTML when the option is off (default)", () => {
    expect(renderMarkdown('<div align="center">x</div>')).toContain("&lt;div");
    expect(renderMarkdown('<div align="center">x</div>')).not.toContain('<div align');
  });
});

// protectHtml is exercised end-to-end above; a direct smoke test pins its contract
// (placeholders for admitted tags, drop for the rest) without the markdown pipeline.
describe("protectHtml direct", () => {
  it("stashes admitted tags and drops the rest", () => {
    const stash: string[] = [];
    const ctx: HtmlCtx = {
      safeHref: (u) => (u.startsWith("https://") ? u : null),
      resolveImg: (src) => `[img:${src}]`,
      keep: (h) => `${stash.push(h) - 1}`,
    };
    const out = protectHtml("<b>x</b><script>y</script><z>w</z>", ctx);
    expect(stash).toEqual(["<b>", "</b>"]);
    expect(out).toBe("0x1w"); // script gone with body, <z> dropped
  });
});
