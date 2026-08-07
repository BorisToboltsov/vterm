#!/usr/bin/env node
// Единая точка смены версии vterm.
//
//   node scripts/set-version.mjs 1.0.1   — поставить версию
//   node scripts/set-version.mjs         — разнести текущую версию package.json
//
// Источник истины — package.json. Оттуда версию берут:
//   • tauri.conf.json — сам, ссылкой "../package.json" (нативная возможность
//     Tauri: поле version принимает путь к package.json). Трогать не нужно.
//   • CI — читает package.json (имя portable-.exe).
//   • Cargo.toml / Cargo.lock — литералом: cargo не умеет ссылок, поэтому
//     версию туда переписывает этот скрипт.
//   • README.md — плашка shields.io (version-X.Y.Z): статичный литерал, ничем
//     не резолвится, поэтому её тоже синкает этот скрипт (иначе тихо отстаёт).
//
// Расхождение ловит гейт src/lib/version.guard.test.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PKG = "package.json";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "src-tauri/Cargo.lock";
const README = "README.md";

/** Схема vterm: major.minor.patch, без пререлизных суффиксов (их не бандлит Tauri). */
const SEMVER = /^\d+\.\d+\.\d+$/;

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const write = (rel, text) => writeFileSync(join(ROOT, rel), text, "utf8");

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};

// ── Целевая версия ────────────────────────────────────────────────────────────
const pkgRaw = read(PKG);
const current = JSON.parse(pkgRaw).version;
const target = process.argv[2] ?? current;

if (!SEMVER.test(target)) {
  fail(`«${target}» — не версия вида major.minor.patch`);
}

// ── package.json ──────────────────────────────────────────────────────────────
// Правим текстом, а не JSON.stringify: пересериализация переформатирует весь
// файл и делает diff нечитаемым.
const pkgNext = pkgRaw.replace(
  /("version"\s*:\s*)"[^"]*"/,
  `$1"${target}"`,
);
if (pkgNext === pkgRaw && current !== target) fail(`не нашёл поле version в ${PKG}`);
write(PKG, pkgNext);

// ── Cargo.toml: только version внутри [package] ───────────────────────────────
// Идём построчно: у зависимостей ниже свои version = "…", и захватить чужую
// строку регуляркой по всему файлу проще, чем кажется.
const tomlLines = read(CARGO_TOML).split("\n");
const start = tomlLines.findIndex((l) => l.trim() === "[package]");
if (start === -1) fail(`не нашёл секцию [package] в ${CARGO_TOML}`);

let tomlTouched = false;
for (let i = start + 1; i < tomlLines.length; i++) {
  if (/^\s*\[/.test(tomlLines[i])) break; // началась следующая секция
  const m = tomlLines[i].match(/^(\s*version\s*=\s*)"[^"]*"(.*)$/);
  if (m) {
    tomlLines[i] = `${m[1]}"${target}"${m[2]}`;
    tomlTouched = true;
    break;
  }
}
if (!tomlTouched) fail(`не нашёл version в секции [package] файла ${CARGO_TOML}`);
write(CARGO_TOML, tomlLines.join("\n"));

// ── Cargo.lock: запись самого пакета vterm ────────────────────────────────────
// Правим точечно, чтобы не требовать cargo (скрипт должен работать и там, где
// нет тулчейна — например, в JS-джобе CI). Версия корневого пакета в локе —
// зеркало манифеста, никаких хэшей за ней не стоит.
const lockRaw = read(CARGO_LOCK);
const lockEntry = /(\[\[package\]\]\nname = "vterm"\nversion = )"[^"]*"/;
if (!lockEntry.test(lockRaw)) fail(`не нашёл запись пакета vterm в ${CARGO_LOCK}`);
write(CARGO_LOCK, lockRaw.replace(lockEntry, `$1"${target}"`));

// ── README.md: плашка версии shields.io ───────────────────────────────────────
// Матчим только числовую часть semver — цвет (`-blue`) и остальные бейджи
// (license/platform/…) не трогаем.
const readmeRaw = read(README);
const badge = /(shields\.io\/badge\/version-)\d+\.\d+\.\d+/;
if (!badge.test(readmeRaw)) fail(`не нашёл плашку версии в ${README}`);
write(README, readmeRaw.replace(badge, `$1${target}`));

// ── Итог ──────────────────────────────────────────────────────────────────────
console.log(
  current === target
    ? `✔ версия ${target} разнесена (package.json → Cargo.toml, Cargo.lock, README.md)`
    : `✔ ${current} → ${target} (package.json, Cargo.toml, Cargo.lock, README.md)`,
);
console.log("  tauri.conf.json берёт версию из package.json ссылкой — не трогаем");
