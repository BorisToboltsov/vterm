#!/usr/bin/env node
// «Полный» portable для Windows: vterm.exe + вшитый WebView2 Fixed Version runtime.
//
//   node scripts/webview2-runtime.mjs resolve
//       → печатает «<версия> <url>» актуального x64 .cab Fixed Version runtime
//   node scripts/webview2-runtime.mjs embed <vterm.exe> <runtime.cab> <версия> <out.exe>
//       → пишет out.exe = vterm.exe + .cab (как есть) + 64-байтовый хвост
//
// Ссылки на Fixed Version у Microsoft не постоянны: страница
// https://developer.microsoft.com/microsoft-edge/webview2/ держит только две
// последние мажорные версии, и старые .cab с сервера пропадают. Поэтому версия не
// пинится в репозитории, а берётся со страницы в момент сборки (ссылки лежат в
// её серверном HTML). Подлинность .cab проверяет CI по подписи Authenticode
// Microsoft, а не мы по хэшу. Переопределение — переменные WEBVIEW2_CAB_URL и
// WEBVIEW2_VERSION (если страница сменит разметку, релиз можно собрать руками).
//
// Формат хвоста обязан совпадать с src-tauri/src/webview2.rs (гейт
// src/lib/webview2runtime.test.ts):
//   версия (16, ASCII, NUL-добивка) · sha256 .cab (32) · длина .cab (8, LE) · "VTWV2RT1"

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAGIC = "VTWV2RT1";
export const TRAILER_LEN = 64;
export const PAGE_URL = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";
/** Единственный хост, с которого принимаем .cab. */
export const CAB_HOST = "msedge.sf.dl.delivery.mp.microsoft.com";

/** @typedef {{version: string, arch: string, url: string}} Cab */

const VERSION_RE = /^\d{1,5}(\.\d{1,5}){3}$/;

/**
 * Версия Fixed Version runtime — ровно четыре числа через точку.
 * @param {unknown} v
 */
export function validVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

/**
 * Все ссылки на .cab Fixed Version из HTML страницы. В серверных данных Nuxt
 * слэши экранированы как `/`, поэтому сначала разворачиваем их.
 * @param {string} html
 * @returns {Cab[]}
 */
export function findFixedRuntimeCabs(html) {
  const text = html.replace(/\\u002F/gi, "/");
  const re =
    /https:\/\/([a-z0-9.-]+)\/filestreamingservice\/files\/[0-9a-f-]+\/Microsoft\.WebView2\.FixedVersionRuntime\.(\d+\.\d+\.\d+\.\d+)\.(x64|x86|arm64)\.cab/gi;
  /** @type {Map<string, Cab>} */
  const seen = new Map();
  for (const m of text.matchAll(re)) {
    if (m[1].toLowerCase() !== CAB_HOST) continue;
    seen.set(m[0], { version: m[2], arch: m[3].toLowerCase(), url: m[0] });
  }
  return [...seen.values()];
}

/**
 * Сравнение версий как чисел: "154.0.4258.48" > "153.0.4234.48", "10" > "9".
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Самая свежая сборка под архитектуру или `null`.
 * @param {Cab[]} cabs
 * @returns {Cab | null}
 */
export function latestCab(cabs, arch = "x64") {
  const own = cabs.filter((c) => c.arch === arch);
  if (own.length === 0) return null;
  return own.reduce((best, c) => (compareVersions(c.version, best.version) > 0 ? c : best));
}

/**
 * URL из переопределения: только https и только хост Microsoft.
 * @param {string} url
 */
export function checkCabUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname.toLowerCase() === CAB_HOST && u.pathname.endsWith(".cab");
}

/**
 * Хвост: версия · sha256 · длина · сигнатура.
 * @param {string} version
 * @param {Buffer} sha256 32 байта
 * @param {bigint|number} cabLen
 */
export function buildTrailer(version, sha256, cabLen) {
  if (!validVersion(version)) throw new Error(`bad runtime version: ${version}`);
  if (!Buffer.isBuffer(sha256) || sha256.length !== 32) throw new Error("sha256 must be 32 bytes");
  const len = BigInt(cabLen);
  if (len <= 0n) throw new Error("empty runtime");
  const out = Buffer.alloc(TRAILER_LEN);
  out.write(version, 0, "ascii");
  sha256.copy(out, 16);
  out.writeBigUInt64LE(len, 48);
  out.write(MAGIC, 56, "ascii");
  return out;
}

/**
 * @param {string} path
 * @param {import("node:fs").WriteStream} out
 * @param {(chunk: Buffer) => void} [onChunk]
 * @returns {Promise<void>}
 */
function pipeInto(path, out, onChunk) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (/** @type {Buffer} */ chunk) => {
      onChunk?.(chunk);
      if (!out.write(chunk)) {
        rs.pause();
        out.once("drain", () => rs.resume());
      }
    });
    rs.on("end", resolve);
    rs.on("error", reject);
  });
}

/**
 * exe + .cab + хвост → out. Хэш и длина .cab считаются по тем же байтам, что пишутся.
 * @param {string} exePath
 * @param {string} cabPath
 * @param {string} version
 * @param {string} outPath
 */
export async function embed(exePath, cabPath, version, outPath) {
  const out = createWriteStream(outPath);
  const done = new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  await pipeInto(exePath, out);
  const hash = createHash("sha256");
  let len = 0n;
  await pipeInto(cabPath, out, (chunk) => {
    hash.update(chunk);
    len += BigInt(chunk.length);
  });
  out.end(buildTrailer(version, hash.digest(), len));
  await done;
}

/** @returns {Promise<{version: string, url: string}>} */
async function resolveCab() {
  const url = process.env.WEBVIEW2_CAB_URL;
  const version = process.env.WEBVIEW2_VERSION;
  if (url || version) {
    if (!checkCabUrl(url ?? "") || !validVersion(version ?? "")) {
      throw new Error(`WEBVIEW2_CAB_URL must be an https .cab on ${CAB_HOST} and WEBVIEW2_VERSION a.b.c.d`);
    }
    return { version: /** @type {string} */ (version), url: /** @type {string} */ (url) };
  }
  const res = await fetch(PAGE_URL);
  if (!res.ok) throw new Error(`${PAGE_URL}: HTTP ${res.status}`);
  const cab = latestCab(findFixedRuntimeCabs(await res.text()));
  if (!cab) {
    throw new Error(`no x64 Fixed Version .cab on ${PAGE_URL} — set WEBVIEW2_CAB_URL and WEBVIEW2_VERSION`);
  }
  return cab;
}

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "resolve") {
    const { version, url } = await resolveCab();
    console.log(`${version} ${url}`);
  } else if (cmd === "embed" && args.length === 4) {
    const [exe, cab, version, out] = args;
    await embed(exe, cab, version, out);
  } else {
    throw new Error("usage: webview2-runtime.mjs resolve | embed <exe> <cab> <version> <out>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✘ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
