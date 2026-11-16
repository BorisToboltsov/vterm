import { describe, expect, it } from "vitest";
import { sanitizeLspHtml } from "./lspsanitize";

describe("sanitizeLspHtml", () => {
  it("keeps the text tags and the highlighter's classes", () => {
    expect(sanitizeLspHtml('<p>Returns <code>int</code></p><pre><code class="language-python"><span class="ͼ1 tok-keyword">def</span> f</code></pre>')).toBe(
      '<p>Returns <code>int</code></p><pre><code class="language-python"><span class="ͼ1 tok-keyword">def</span> f</code></pre>',
    );
    expect(sanitizeLspHtml("a<br/>b<hr>")).toBe("a<br>b<hr>");
  });

  it("drops what runs or fetches, with or without its contents", () => {
    expect(sanitizeLspHtml('<img src=x onerror="alert(1)">hi')).toBe("hi");
    expect(sanitizeLspHtml("<script>alert(1)</script>ok")).toBe("ok");
    expect(sanitizeLspHtml("<svg><a xlink:href=javascript:x>b</a></svg>after")).toBe("after");
    expect(sanitizeLspHtml('<a href="javascript:alert(1)">link</a>')).toBe("link");
    expect(sanitizeLspHtml('<span onclick="x()" style="color:red" class="a b">t</span>')).toBe('<span class="a b">t</span>');
    expect(sanitizeLspHtml('<span class="x&quot; onmouseover=y">t</span>')).toBe("<span>t</span>");
    expect(sanitizeLspHtml("<style>*{}</style><iframe src=x></iframe>z")).toBe("z");
    expect(sanitizeLspHtml("<script>never closed")).toBe("");
  });

  it("turns a stray angle bracket into text", () => {
    expect(sanitizeLspHtml("a < b > c")).toBe("a &lt; b &gt; c");
    expect(sanitizeLspHtml("<<p>x</p>")).toBe("&lt;<p>x</p>");
    expect(sanitizeLspHtml("<!-- note -->x")).toBe("x");
    expect(sanitizeLspHtml("&lt;tag&gt;")).toBe("&lt;tag&gt;");
  });
});
