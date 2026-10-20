import { describe, expect, it } from "vitest";
import {
  addressParts,
  isTerminalLinkMode,
  linkClick,
  linkTarget,
  misleadingHost,
  rangeText,
  textHost,
} from "./termlink";

describe("linkTarget", () => {
  it("takes http and https and nothing else", () => {
    expect(linkTarget("https://example.com/a?b=1")?.href).toBe("https://example.com/a?b=1");
    expect(linkTarget("http://example.com")?.href).toBe("http://example.com/");
    expect(linkTarget("https://example.com")?.openable).toBe(true);
    expect(linkTarget("http://example.com")?.openable).toBe(false);
    for (const uri of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ssh://host",
      "mailto:a@b.c",
      "data:text/html,x",
      "example.com",
      "not a url",
      "",
    ]) {
      expect(linkTarget(uri), uri).toBeNull();
    }
  });

  it("shows a non-Latin host as the browser will connect to it", () => {
    // Cyrillic "і" in place of the Latin one.
    const t = linkTarget("https://gіthub.com/x");
    expect(t?.host.startsWith("xn--")).toBe(true);
    expect(t?.idn).toBe(true);
    expect(linkTarget("https://пример.рф/")?.idn).toBe(true);
    expect(linkTarget("https://example.com/")?.idn).toBe(false);
  });

  it("lowercases the host and keeps IPv6 brackets", () => {
    expect(linkTarget("https://EXAMPLE.com/Path")?.host).toBe("example.com");
    expect(linkTarget("http://[::1]:8080/")?.host).toBe("[::1]");
  });
});

describe("addressParts", () => {
  const parts = (uri: string) => addressParts(linkTarget(uri)!);

  it("splits around the host", () => {
    expect(parts("https://example.com:8443/a?b#c")).toEqual({
      before: "https://",
      host: "example.com",
      after: ":8443/a?b#c",
    });
  });

  it("leaves a trusted name put in the user part outside the host", () => {
    expect(parts("https://github.com@evil.io/login")).toEqual({
      before: "https://github.com@",
      host: "evil.io",
      after: "/login",
    });
    expect(parts("https://evil.io@evil.io/")).toEqual({
      before: "https://evil.io@",
      host: "evil.io",
      after: "/",
    });
  });

  it("finds the host of an IPv6 address", () => {
    expect(parts("http://[::1]:8080/x").host).toBe("[::1]");
  });
});

describe("textHost", () => {
  it("reads a URL or a bare site name", () => {
    expect(textHost("https://GitHub.com/x")).toBe("github.com");
    expect(textHost("github.com")).toBe("github.com");
    expect(textHost("www.github.com/org/repo")).toBe("www.github.com");
    expect(textHost("  docs.example.org:8080  ")).toBe("docs.example.org");
  });

  it("does not read words or versions as sites", () => {
    for (const text of ["docs", "click here", "v1.2", "1.2.3", "", "a b.com"]) {
      expect(textHost(text), text).toBeNull();
    }
  });
});

describe("misleadingHost", () => {
  const target = linkTarget("https://evil.io/login")!;

  it("names the host the text claims when the link goes elsewhere", () => {
    expect(misleadingHost("github.com", target)).toBe("github.com");
    expect(misleadingHost("https://github.com/login", target)).toBe("github.com");
    expect(misleadingHost("evil.io.github.com", target)).toBe("evil.io.github.com");
  });

  it("is quiet when the text claims the same site or none", () => {
    expect(misleadingHost("evil.io", target)).toBeNull();
    expect(misleadingHost("www.evil.io/login", target)).toBeNull();
    expect(misleadingHost("the docs", target)).toBeNull();
  });

  it("counts another subdomain as another site", () => {
    expect(misleadingHost("docs.github.com", linkTarget("https://github.com/")!)).toBe(
      "docs.github.com",
    );
  });
});

describe("linkClick", () => {
  it("asks by default and opens right away in direct mode", () => {
    const asked = linkClick("confirm", "https://example.com/");
    expect(asked).toEqual({
      kind: "ask",
      question: {
        target: { href: "https://example.com/", host: "example.com", idn: false, openable: true },
        shown: null,
        canSilence: true,
      },
    });
    expect(linkClick("direct", "https://example.com/")).toEqual({
      kind: "open",
      href: "https://example.com/",
    });
  });

  it("never opens in off mode or for another scheme", () => {
    expect(linkClick("off", "https://example.com/")).toEqual({ kind: "ignore" });
    expect(linkClick("direct", "file:///etc/passwd")).toEqual({ kind: "ignore" });
    expect(linkClick("confirm", "javascript:alert(1)", "github.com")).toEqual({ kind: "ignore" });
  });

  it("asks about a misleading OSC 8 link even in direct mode, without offering silence", () => {
    const action = linkClick("direct", "https://evil.io/", "github.com");
    expect(action).toMatchObject({ kind: "ask", question: { shown: "github.com", canSilence: false } });
  });

  it("offers an http link for copying only, in every mode but off", () => {
    for (const mode of ["confirm", "direct"] as const) {
      expect(linkClick(mode, "http://localhost:8080/")).toMatchObject({
        kind: "ask",
        question: { target: { openable: false }, canSilence: false },
      });
    }
    expect(linkClick("off", "http://localhost:8080/")).toEqual({ kind: "ignore" });
  });

  it("opens an OSC 8 link whose text names no site, or its own", () => {
    expect(linkClick("direct", "https://example.com/x", "here")).toEqual({
      kind: "open",
      href: "https://example.com/x",
    });
    expect(linkClick("direct", "https://example.com/x", "example.com/x").kind).toBe("open");
  });
});

describe("rangeText", () => {
  const buf = (lines: string[]) => ({
    getLine: (y: number) =>
      lines[y] === undefined
        ? undefined
        : { translateToString: (_t?: boolean, s = 0, e?: number) => lines[y].slice(s, e) },
  });

  it("reads a 1-based, end-inclusive range", () => {
    expect(rangeText(buf(["x github.com y"]), { start: { x: 3, y: 1 }, end: { x: 12, y: 1 } })).toBe(
      "github.com",
    );
  });

  it("joins a range over several rows and skips rows that are gone", () => {
    const lines = ["....https://exa", "mple.com/x ..."];
    expect(rangeText(buf(lines), { start: { x: 5, y: 1 }, end: { x: 10, y: 2 } })).toBe(
      "https://example.com/x",
    );
    expect(rangeText(buf([]), { start: { x: 1, y: 1 }, end: { x: 3, y: 1 } })).toBe("");
  });
});

describe("isTerminalLinkMode", () => {
  it("accepts the three modes only", () => {
    expect(["confirm", "direct", "off"].every(isTerminalLinkMode)).toBe(true);
    expect([undefined, null, "", "ask", 1].some(isTerminalLinkMode)).toBe(false);
  });
});
