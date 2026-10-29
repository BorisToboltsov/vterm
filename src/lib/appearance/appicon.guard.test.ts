// Guard: the bundled app icon is framed per platform.
//
// The master SVG draws the squircle inside a transparent safe-area margin because
// macOS requires one — a Dock icon without it reads as oversized. Windows has no
// such convention (the shell adds its own padding), so the same framing renders
// the icon ~19% smaller than every neighbour in the taskbar and Explorer. That is
// exactly what shipped until v1.0.17.
//
// The trap is that the obvious regeneration command — `pnpm tauri icon <svg>` —
// applies one framing to every output, so a single innocent re-run silently
// restores the bug. `pnpm icons` (scripts/make-icons.mjs) re-frames the Windows
// assets; this test is what notices when someone doesn't.
//
// It measures the real pixels rather than trusting the generator: decode the
// largest image out of each artefact and compare its alpha bounding box to the
// canvas.
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ICONS = join(process.cwd(), "src-tauri/icons");

/** Decode an 8-bit RGBA PNG to `{ width, height, pixels }`. */
function decodePng(data: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let pos = 8;
  let header: { width: number; height: number; depth: number; colorType: number } | null = null;
  const idat: Buffer[] = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString("ascii");
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        depth: chunk[8],
        colorType: chunk[9],
      };
    } else if (type === "IDAT") {
      idat.push(chunk);
    }
    pos += 12 + len;
  }
  if (!header) throw new Error("PNG without IHDR");
  // The generator only ever emits truecolour+alpha; anything else means the
  // pipeline changed and the measurement below would be meaningless.
  expect([header.depth, header.colorType]).toEqual([8, 6]);

  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = Buffer.from(raw.subarray(at, at + stride));
    at += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, pixels: out };
}

/** How much of the canvas the opaque mark spans, as a percentage of its width. */
function coveragePct(png: Buffer): number {
  const { width, height, pixels } = decodePng(png);
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  expect(right).toBeGreaterThanOrEqual(0); // a fully transparent icon is a bug of its own
  return ((right - left + 1) / width) * 100;
}

/** The largest image packed into an .ico (entries are PNGs here). */
function largestIcoImage(path: string): Buffer {
  const data = readFileSync(path);
  const count = data.readUInt16LE(4);
  let best: { width: number; png: Buffer } | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const width = data[entry] || 256;
    const size = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    if (!best || width > best.width) {
      best = { width, png: data.subarray(offset, offset + size) };
    }
  }
  if (!best) throw new Error("empty .ico");
  return best.png;
}

describe("app icon framing", () => {
  it("fills the canvas on Windows — no macOS safe area in the .ico", () => {
    // Was 82% before v1.0.17, which is what made it look small in the taskbar.
    expect(coveragePct(largestIcoImage(join(ICONS, "icon.ico")))).toBeGreaterThan(93);
  });

  it("fills the canvas in the Windows tile/store logos too", () => {
    for (const name of ["StoreLogo.png", "Square150x150Logo.png", "Square310x310Logo.png"]) {
      expect(coveragePct(readFileSync(join(ICONS, name)))).toBeGreaterThan(93);
    }
  });

  it("keeps the safe-area margin on macOS, where the Dock expects it", () => {
    // The opposite failure: re-framing everything would make the Dock icon
    // oversized next to stock ones. ~81% is the HIG proportion the master draws.
    const macCoverage = coveragePct(readFileSync(join(ICONS, "128x128@2x.png")));
    expect(macCoverage).toBeGreaterThan(75);
    expect(macCoverage).toBeLessThan(88);
  });

  it("keeps the master SVG's viewBox, which is what the Windows re-frame edits", () => {
    // scripts/make-icons.mjs re-frames by string-replacing this exact attribute;
    // changing it silently turns the Windows step into a no-op.
    const svg = readFileSync(join(ICONS, "icon-source.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 1024 1024"');
  });
});
