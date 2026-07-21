import { describe, expect, it } from "vitest";
import { badgeColor, badgeSvg, parseStaticBadge, renderBadge, textWidth } from "./badge";

// Phase 44.5. Drawing a badge locally is only legitimate because a STATIC shields
// URL is a complete specification of the picture — so the tests that matter most
// are the ones policing where that stops being true.
describe("parseStaticBadge", () => {
  it("reads the three-field form", () => {
    expect(parseStaticBadge("https://img.shields.io/badge/version-0.44.4-blue")).toEqual({
      label: "version",
      message: "0.44.4",
      color: "#007ec6",
      labelColor: "#555",
      square: false,
      caps: false,
    });
  });

  it("reads the two-field (message-only) form", () => {
    expect(parseStaticBadge("https://img.shields.io/badge/passing-brightgreen")).toMatchObject({
      label: "",
      message: "passing",
      color: "#4c1",
    });
  });

  it("accepts a bare hex colour, which is what most READMEs use", () => {
    expect(parseStaticBadge("https://img.shields.io/badge/Tauri-2-24C8DB")).toMatchObject({
      label: "Tauri",
      message: "2",
      color: "#24c8db",
    });
  });

  it("applies shields' escaping rules to each field", () => {
    // `--` is a literal dash, `__` a literal underscore, a lone `_` a space.
    expect(parseStaticBadge("https://img.shields.io/badge/build-pre--release-green")).toMatchObject(
      { message: "pre-release" },
    );
    expect(parseStaticBadge("https://img.shields.io/badge/a_b-c__d-red")).toMatchObject({
      label: "a b",
      message: "c_d",
    });
    expect(
      parseStaticBadge("https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey"),
    ).toMatchObject({ message: "macOS | Linux" });
  });

  it("survives the HTML escaping the renderer applies before it is called", () => {
    // The target reaches the badge parser already escaped, so `&` is `&amp;`.
    expect(
      parseStaticBadge("https://img.shields.io/badge/a-b-blue?style=flat-square&amp;logo=rust"),
    ).toMatchObject({ square: true });
  });

  it("honours style and colour overrides", () => {
    expect(parseStaticBadge("https://img.shields.io/badge/a-b-blue?style=flat-square")).toMatchObject(
      { square: true, caps: false },
    );
    expect(
      parseStaticBadge("https://img.shields.io/badge/a-b-blue?style=for-the-badge"),
    ).toMatchObject({ caps: true });
    expect(
      parseStaticBadge("https://img.shields.io/badge/a-b-blue?color=red&labelColor=orange"),
    ).toMatchObject({ color: "#e05d44", labelColor: "#fe7d37" });
  });

  it("REFUSES every dynamic endpoint — that content lives on a server", () => {
    // The whole justification for drawing badges locally is that nothing is
    // guessed. A dynamic badge's message comes from an API at request time;
    // inventing a plausible star count or version is exactly the fake this
    // codebase forbids elsewhere.
    for (const url of [
      "https://img.shields.io/github/stars/tauri-apps/tauri",
      "https://img.shields.io/npm/v/svelte",
      "https://img.shields.io/badge/dynamic/json?url=https://x.test/a.json&query=$.v",
      "https://img.shields.io/gitlab/pipeline-status/foo",
    ]) {
      expect(parseStaticBadge(url)).toBeNull();
    }
  });

  it("refuses a badge whose colour field we do not understand", () => {
    // Defaulting would draw a field we failed to read.
    expect(parseStaticBadge("https://img.shields.io/badge/a-b-notacolour")).toBeNull();
    expect(parseStaticBadge("https://img.shields.io/badge/onefield")).toBeNull();
  });

  it("refuses anything that is not shields.io", () => {
    expect(parseStaticBadge("https://evil.test/badge/a-b-blue")).toBeNull();
    expect(parseStaticBadge("https://shields.io.evil.test/badge/a-b-blue")).toBeNull();
    expect(parseStaticBadge("./docs/a.png")).toBeNull();
    // …but both the bare and the `img.` host are real.
    expect(parseStaticBadge("https://shields.io/badge/a-b-blue")).not.toBeNull();
  });
});

describe("badgeColor", () => {
  it("resolves names, aliases and hex", () => {
    expect(badgeColor("brightgreen")).toBe("#4c1");
    expect(badgeColor("critical")).toBe("#e05d44");
    expect(badgeColor("GRAY")).toBe("#555");
    expect(badgeColor("#abc")).toBe("#abc");
    expect(badgeColor("24C8DB")).toBe("#24c8db");
  });

  it("returns null for anything else", () => {
    expect(badgeColor("chartreuse")).toBeNull();
    expect(badgeColor("")).toBeNull();
    // A colour reaches an SVG attribute unquoted-escaped, so the allowlist is what
    // stands between a crafted URL and attribute injection.
    expect(badgeColor('"/><script>x</script>')).toBeNull();
    expect(badgeColor("red; x")).toBeNull();
  });
});

describe("badgeSvg", () => {
  const base = { label: "build", message: "passing", color: "#4c1", labelColor: "#555" };

  it("draws both halves with the parsed text and fills", () => {
    const svg = badgeSvg({ ...base, square: false, caps: false });
    expect(svg).toContain("<svg");
    expect(svg).toContain('fill="#4c1"');
    expect(svg).toContain('fill="#555"');
    expect(svg).toContain(">build</text>");
    expect(svg).toContain(">passing</text>");
    expect(svg).toContain('aria-label="build: passing"');
  });

  it("escapes text so a crafted label cannot break out of the markup", () => {
    const svg = badgeSvg({ ...base, label: '"><script>x</script>', square: false, caps: false });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("uses no ids, so several badges on one page cannot collide", () => {
    // Rounded corners are done with overlapping rects rather than a clipPath for
    // exactly this reason — a shared id would give every badge the first one's
    // geometry.
    expect(badgeSvg({ ...base, square: false, caps: false })).not.toContain("id=");
  });

  it("carries no style attribute, which a CSP nonce would silently kill", () => {
    // `tauri build` stamps a nonce into style-src, cancelling 'unsafe-inline' —
    // a style-attribute badge would lose every colour in the packaged app only.
    expect(badgeSvg({ ...base, square: false, caps: false })).not.toContain("style=");
  });

  it("squares the corners for flat-square and upper-cases for-the-badge", () => {
    expect(badgeSvg({ ...base, square: true, caps: false })).toContain('rx="0"');
    const caps = badgeSvg({ ...base, square: false, caps: true });
    expect(caps).toContain(">BUILD</text>");
    expect(caps).toContain('height="28"');
  });

  it("darkens the text on a light fill instead of leaving it unreadable", () => {
    expect(badgeSvg({ ...base, color: "#ffffff", square: false, caps: false })).toContain(
      'fill="#333"',
    );
  });

  it("omits the label half for a message-only badge", () => {
    const svg = badgeSvg({ ...base, label: "", square: false, caps: false });
    expect(svg).not.toContain('fill="#555"');
    expect(svg).toContain('aria-label="passing"');
  });
});

describe("textWidth", () => {
  it("grows with length and scales with font size", () => {
    expect(textWidth("mm", 11)).toBeGreaterThan(textWidth("ii", 11));
    expect(textWidth("abc", 22)).toBeCloseTo(textWidth("abc", 11) * 2);
    expect(textWidth("", 11)).toBe(0);
  });
});

describe("renderBadge", () => {
  it("draws a static badge and declines everything else", () => {
    expect(renderBadge("https://img.shields.io/badge/license-MIT-green")).toContain("<svg");
    expect(renderBadge("https://img.shields.io/github/stars/a/b")).toBeNull();
    expect(renderBadge("./a.png")).toBeNull();
  });
});
