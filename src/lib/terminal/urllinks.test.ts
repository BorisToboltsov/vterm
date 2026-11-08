import { describe, expect, it } from "vitest";
import type { ILink } from "@xterm/xterm";
import { createUrlLinks, findUrls, isWebAddress, type UrlTerminal } from "./urllinks";

const spans = (text: string) => findUrls(text).map(({ from, to }) => text.slice(from, to));

describe("isWebAddress", () => {
  it("takes http and https addresses", () => {
    expect(isWebAddress("https://example.com/a?b=1#c")).toBe(true);
    expect(isWebAddress("http://10.0.0.1:8080/")).toBe(true);
    expect(isWebAddress("https://user@example.com/")).toBe(true);
  });

  it("takes a host spelled in its own letters", () => {
    expect(isWebAddress("https://пример.рф/путь")).toBe(true);
    expect(isWebAddress("http://例子.测试")).toBe(true);
    expect(isWebAddress("https://ПРИМЕР.РФ")).toBe(true);
  });

  it("refuses what is no web address, or one the parser reads differently", () => {
    expect(isWebAddress("ftp://example.com/")).toBe(false);
    expect(isWebAddress("https://")).toBe(false);
    expect(isWebAddress("https:///path")).toBe(false);
    expect(isWebAddress("https://exa mple.com")).toBe(false);
    // The parser takes `\` for `/` in a special scheme: the host would not be the text's.
    expect(isWebAddress("https://evil.com\\@good.com/")).toBe(false);
  });
});

describe("findUrls", () => {
  it("finds every address on a line", () => {
    expect(spans("see https://a.example/x and http://b.example")).toEqual([
      "https://a.example/x",
      "http://b.example",
    ]);
  });

  it("finds an address with a non-Latin host or path", () => {
    expect(spans("сайт: https://пример.рф/страница — тут")).toEqual(["https://пример.рф/страница"]);
    expect(spans("https://example.com/документы/отчёт.pdf")).toEqual(["https://example.com/документы/отчёт.pdf"]);
  });

  it("leaves closing punctuation and quotes outside", () => {
    expect(spans("(see https://example.com/a).")).toEqual(["https://example.com/a"]);
    expect(spans("«https://пример.рф»")).toEqual(["https://пример.рф"]);
    expect(spans('"https://example.com",')).toEqual(["https://example.com"]);
  });

  it("finds nothing in a line without one", () => {
    expect(findUrls("ls -la /etc")).toEqual([]);
    expect(findUrls("https:// nothing")).toEqual([]);
  });
});

/** A buffer of rows; `wide` marks the characters that take two cells. */
function fakeTerm(rows: { text: string; wrapped?: boolean; wide?: string }[], cols = 40): UrlTerminal {
  const line = (r: { text: string; wrapped?: boolean; wide?: string }) => {
    const cells: { ch: string; w: number }[] = [];
    for (const ch of r.text) {
      const w = r.wide?.includes(ch) ? 2 : 1;
      cells.push({ ch, w });
      if (w === 2) cells.push({ ch: "", w: 0 });
    }
    return {
      isWrapped: r.wrapped ?? false,
      length: cols,
      getCell: (x: number) => {
        const c = cells[x];
        return { getChars: () => c?.ch ?? "", getWidth: () => c?.w ?? 1 };
      },
    };
  };
  return {
    cols,
    buffer: { active: { getLine: (y: number) => (rows[y] ? line(rows[y]) : undefined) } },
  } as unknown as UrlTerminal;
}

function linksOf(term: UrlTerminal, y: number, open: (uri: string) => void = () => {}): ILink[] {
  let got: ILink[] | undefined;
  createUrlLinks(term, open).provideLinks(y, (links) => (got = links));
  return got ?? [];
}

describe("createUrlLinks", () => {
  it("offers the address of the hovered line, and a click opens it", () => {
    const opened: string[] = [];
    const links = linksOf(fakeTerm([{ text: "go https://пример.рф/x now" }]), 1, (u) => opened.push(u));
    expect(links.map((l) => [l.text, l.range])).toEqual([
      ["https://пример.рф/x", { start: { x: 4, y: 1 }, end: { x: 22, y: 1 } }],
    ]);
    links[0].activate(new MouseEvent("click"), links[0].text);
    expect(opened).toEqual(["https://пример.рф/x"]);
  });

  it("reads an address across the rows it wraps onto", () => {
    const term = fakeTerm(
      [
        { text: "abcdefghij https://exa" },
        { text: "mple.com/long", wrapped: true },
      ],
      22,
    );
    const range = { start: { x: 12, y: 1 }, end: { x: 13, y: 2 } };
    expect(linksOf(term, 2).map((l) => [l.text, l.range])).toEqual([["https://example.com/long", range]]);
    expect(linksOf(term, 1).map((l) => l.text)).toEqual(["https://example.com/long"]);
  });

  it("places the link past wide characters by their cells", () => {
    const term = fakeTerm([{ text: "日本 https://例子.测试", wide: "日本例子测试" }]);
    const [link] = linksOf(term, 1);
    expect(link.text).toBe("https://例子.测试");
    // 日本 take four cells and the space one: the address starts at cell 6
    // ends on the second cell of 试, the 22nd.
    expect(link.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 22, y: 1 } });
  });

  it("offers nothing on a line without an address", () => {
    let called = false;
    createUrlLinks(fakeTerm([{ text: "plain" }]), () => {}).provideLinks(1, (links) => {
      called = true;
      expect(links).toBeUndefined();
    });
    expect(called).toBe(true);
  });
});
