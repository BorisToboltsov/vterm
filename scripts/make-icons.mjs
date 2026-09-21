#!/usr/bin/env node
// Генерация всего набора иконок приложения из одного мастер-SVG.
//
//   pnpm icons
//
// Зачем скрипт, а не одна команда `tauri icon`. Платформы расходятся в том,
// какую долю квадрата должно занимать тело иконки:
//
//   • macOS (HIG) — вокруг squircle обязательна прозрачная safe area, иначе
//     иконка в Dock выглядит крупнее соседних. Мастер-SVG её и рисует:
//     тело 824x824 на канвасе 1024 = 80.5 %.
//   • Windows — такого соглашения нет, отступы рисует сама система. Та же
//     геометрия даёт иконку заметно мельче соседних в панели задач и Explorer.
//
// Поэтому Windows-артефакты генерируются из того же SVG со **сдвинутым
// viewBox**: safe area обрезается, тело занимает ~97 % квадрата. Второго
// исходника нет намеренно — геометрия знака не должна разъехаться между
// платформами; расходится только рамка кадрирования.
//
// Контракт закреплён гейтом src/lib/appicon.guard.test.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(ROOT, "src-tauri/icons");
const SOURCE = join(ICONS, "icon-source.svg");

/** Мастер-кадр: канвас целиком, тело с macOS safe area. */
const MAC_VIEWBOX = 'viewBox="0 0 1024 1024"';
/** Windows-кадр: safe area обрезана (тело 824 из 856 ≈ 96 % квадрата). */
const WIN_VIEWBOX = 'viewBox="84 84 856 856"';

/** Артефакты, которые берутся из Windows-кадра; остальные — из мастер-кадра. */
const WINDOWS_ASSETS = [
  "icon.ico",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
];

/** `tauri icon` заодно пишет мобильные наборы — этому приложению они не нужны. */
const UNUSED = ["android", "ios", "64x64.png"];

function tauriIcon(input, output) {
  execFileSync("pnpm", ["tauri", "icon", input, "-o", output], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const tmp = mkdtempSync(join(tmpdir(), "vterm-icons-"));
try {
  // 1. Мастер-кадр → весь набор (macOS/Linux получают safe area).
  tauriIcon(SOURCE, ICONS);
  for (const name of UNUSED) rmSync(join(ICONS, name), { recursive: true, force: true });

  // 2. Windows-кадр → только те файлы, что показывает Windows.
  const winSvg = join(tmp, "icon-windows.svg");
  const master = readFileSync(SOURCE, "utf8");
  if (!master.includes(MAC_VIEWBOX)) {
    throw new Error(`не нашёл ${MAC_VIEWBOX} в ${SOURCE} — кадрирование не применить`);
  }
  writeFileSync(winSvg, master.replace(MAC_VIEWBOX, WIN_VIEWBOX));
  const winOut = join(tmp, "out");
  tauriIcon(winSvg, winOut);
  for (const name of WINDOWS_ASSETS) cpSync(join(winOut, name), join(ICONS, name));

  console.log(`✔ иконки обновлены: ${WINDOWS_ASSETS.length} windows-артефактов кадрированы без safe area`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
