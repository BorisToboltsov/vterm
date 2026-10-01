// «Полный» portable Windows: скрипт CI, который находит WebView2 Fixed Version
// runtime и вшивает его в хвост vterm.exe (scripts/webview2-runtime.mjs), и его
// договор с читателем хвоста в Rust (src-tauri/src/webview2.rs). Формат описан в
// двух языках — гейт держит их вместе: разъезд значит, что «полный» portable молча
// перестанет находить свой runtime и упадёт на машине без WebView2.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as wv from "../../scripts/webview2-runtime.mjs";

const ROOT = join(__dirname, "..", "..");
const rust = readFileSync(join(ROOT, "src-tauri/src/webview2.rs"), "utf8");

const CAB = (guid: string, version: string, arch: string) =>
  `https:\\u002F\\u002Fmsedge.sf.dl.delivery.mp.microsoft.com\\u002Ffilestreamingservice\\u002Ffiles\\u002F${guid}\\u002FMicrosoft.WebView2.FixedVersionRuntime.${version}.${arch}.cab`;

// Кусок серверных данных страницы Microsoft в той форме, в какой он приходит.
const PAGE = `{"version":6,"builds":7},"154.0.4258.48",[8,11,14],{"architecture":9,"url":10},"x64","${CAB(
  "621dd012-b3d6-4b8b-a6b7-fc3938bfe9d4",
  "154.0.4258.48",
  "x64",
)}",{"architecture":12,"url":13},"x86","${CAB("3bc3a361-9627-4e64-b5bc-b23cedf95aa3", "154.0.4258.48", "x86")}",
"153.0.4234.48","${CAB("aaaaaaaa-0000-0000-0000-000000000000", "153.0.4234.48", "x64")}",
"${CAB("bbbbbbbb-0000-0000-0000-000000000000", "9.0.0.1", "x64").replace("msedge.sf.dl.delivery.mp.microsoft.com", "evil.example")}"`;

describe("поиск .cab на странице Microsoft", () => {
  it("достаёт все ссылки Fixed Version и разворачивает \\u002F", () => {
    const cabs = wv.findFixedRuntimeCabs(PAGE);
    expect(cabs.map((c: { arch: string }) => c.arch).sort()).toEqual(["x64", "x64", "x86"]);
    for (const c of cabs) expect(c.url).toMatch(/^https:\/\/msedge\.sf\.dl\.delivery\.mp\.microsoft\.com\//);
  });

  it("берёт самую свежую x64-сборку", () => {
    const cab = wv.latestCab(wv.findFixedRuntimeCabs(PAGE));
    expect(cab?.version).toBe("154.0.4258.48");
    expect(cab?.url).toContain("621dd012");
  });

  it("не принимает .cab с чужого хоста", () => {
    expect(wv.findFixedRuntimeCabs(PAGE).some((c: { url: string }) => c.url.includes("evil"))).toBe(false);
  });

  it("пустая или сменившаяся страница — null, а не случайная ссылка", () => {
    expect(wv.latestCab(wv.findFixedRuntimeCabs("<html></html>"))).toBeNull();
    expect(wv.latestCab(wv.findFixedRuntimeCabs(PAGE), "arm64")).toBeNull();
  });

  it("сравнивает версии как числа", () => {
    expect(wv.compareVersions("10.0.0.0", "9.9.9.9")).toBeGreaterThan(0);
    expect(wv.compareVersions("154.0.4258.48", "154.0.4258.100")).toBeLessThan(0);
    expect(wv.compareVersions("1.2.3.4", "1.2.3.4")).toBe(0);
  });

  it("переопределение URL — только https на хосте Microsoft", () => {
    expect(wv.checkCabUrl(wv.findFixedRuntimeCabs(PAGE)[0].url)).toBe(true);
    expect(wv.checkCabUrl("http://msedge.sf.dl.delivery.mp.microsoft.com/a.cab")).toBe(false);
    expect(wv.checkCabUrl("https://evil.example/a.cab")).toBe(false);
    expect(wv.checkCabUrl("https://msedge.sf.dl.delivery.mp.microsoft.com/a.exe")).toBe(false);
    expect(wv.checkCabUrl("not a url")).toBe(false);
  });
});

describe("хвост exe", () => {
  it("раскладка: версия · sha256 · длина LE · сигнатура", () => {
    const sha = Buffer.alloc(32, 7);
    const t = wv.buildTrailer("154.0.4258.48", sha, 307904013);
    expect(t.length).toBe(64);
    expect(t.subarray(0, 16).toString("ascii").replace(/\0+$/, "")).toBe("154.0.4258.48");
    expect(t.subarray(16, 48).equals(sha)).toBe(true);
    expect(t.readBigUInt64LE(48)).toBe(307904013n);
    expect(t.subarray(56).toString("ascii")).toBe("VTWV2RT1");
  });

  it("не пишет хвост, который Rust отверг бы", () => {
    const sha = Buffer.alloc(32);
    expect(() => wv.buildTrailer("..\\..\\x", sha, 1)).toThrow();
    expect(() => wv.buildTrailer("1.2.3", sha, 1)).toThrow();
    expect(() => wv.buildTrailer("1.2.3.4", Buffer.alloc(31), 1)).toThrow();
    expect(() => wv.buildTrailer("1.2.3.4", sha, 0)).toThrow();
  });

  it("embed: exe и .cab — байт в байт, хэш — по .cab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vterm-wv2-"));
    const exe = Buffer.from("MZ fake exe");
    const cab = Buffer.from("MSCF fake cab payload");
    writeFileSync(join(dir, "vterm.exe"), exe);
    writeFileSync(join(dir, "rt.cab"), cab);
    await wv.embed(join(dir, "vterm.exe"), join(dir, "rt.cab"), "154.0.4258.48", join(dir, "out.exe"));
    const out = readFileSync(join(dir, "out.exe"));
    expect(out.subarray(0, exe.length).equals(exe)).toBe(true);
    expect(out.subarray(exe.length, exe.length + cab.length).equals(cab)).toBe(true);
    const tail = out.subarray(out.length - 64);
    expect(tail.subarray(16, 48).equals(createHash("sha256").update(cab).digest())).toBe(true);
    expect(tail.readBigUInt64LE(48)).toBe(BigInt(cab.length));
    expect(out.length).toBe(exe.length + cab.length + 64);
  });
});

describe("договор с src-tauri/src/webview2.rs", () => {
  it("одна сигнатура и одна длина хвоста", () => {
    expect(rust).toContain(`pub const MAGIC: &[u8; 8] = b"${wv.MAGIC}";`);
    expect(rust).toContain(`pub const TRAILER_LEN: usize = ${wv.TRAILER_LEN};`);
  });

  it("одни смещения полей", () => {
    expect(rust).toContain("const VERSION_LEN: usize = 16;");
    expect(rust).toContain("&tail[56..64] != MAGIC");
    expect(rust).toContain("copy_from_slice(&tail[16..48])");
    expect(rust).toContain("u64::from_le_bytes(tail[48..56]");
  });

  it("одна переменная окружения загрузчика WebView2", () => {
    expect(rust).toContain('pub const ENV_FOLDER: &str = "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER";');
  });
});
