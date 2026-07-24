// Version guard: версия vterm лежит РОВНО в одном месте — package.json.
//
// До этого гейта её приходилось поднимать в трёх файлах руками (package.json,
// Cargo.toml, tauri.conf.json), и рассинхрон был вопросом времени: собранное
// приложение показывало в «О программе» одну версию, имя portable-.exe несло
// другую, а crate — третью. Ни один тест этого не видел.
//
// Схема теперь такая:
//   package.json      — источник истины, единственный литерал, который правят
//   tauri.conf.json   — ссылка "../package.json" (нативная возможность Tauri:
//                       поле version принимает путь к package.json)
//   Cargo.toml/.lock  — литерал, cargo ссылок не умеет → синкает set-version.mjs
//   CI                — читает package.json (см. ниже, почему это критично)
//
// Менять версию: `pnpm version:set X.Y.Z`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const pkgVersion: string = JSON.parse(read("package.json")).version;

describe("версия живёт в package.json", () => {
  it("это версия вида major.minor.patch", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("tauri.conf.json не держит свою копию версии", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

  // Литерал здесь — самый вероятный откат: он «работает» локально и молча
  // расходится с package.json при следующем бампе.
  it("ссылается на package.json, а не на число", () => {
    expect(conf.version).toBe("../package.json");
  });
});

describe("Cargo держит ту же версию", () => {
  // Секцию [package] отделяем явно: у зависимостей ниже свои version = "…".
  const packageSection = (toml: string): string => {
    const lines = toml.split("\n");
    const start = lines.findIndex((l) => l.trim() === "[package]");
    expect(start, "секция [package] не найдена").toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\s*\[/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  };

  it("Cargo.toml — из package.json", () => {
    const m = packageSection(read("src-tauri/Cargo.toml")).match(
      /^\s*version\s*=\s*"([^"]*)"/m,
    );
    expect(m, "version в [package] не найдена").not.toBeNull();
    expect(m![1]).toBe(pkgVersion);
  });

  it("Cargo.lock — из package.json (иначе падает сборка с --locked)", () => {
    const m = read("src-tauri/Cargo.lock").match(
      /\[\[package\]\]\nname = "vterm"\nversion = "([^"]*)"/,
    );
    expect(m, "запись пакета vterm в Cargo.lock не найдена").not.toBeNull();
    expect(m![1]).toBe(pkgVersion);
  });
});

// Отдельный класс регрессии, а не придирка к стилю: `version` в tauri.conf.json
// теперь СТРОКА "../package.json". Пайплайн, который по привычке достанет
// оттуда `.version`, не упадёт — он соберёт файл с именем
// `vterm-portable-../package.json-x86_64.exe` и зальёт его в релиз.
describe("CI берёт версию из package.json, а не из tauri.conf.json", () => {
  const WORKFLOWS = [".github/workflows/release.yml", ".gitlab-ci.yml"];

  const code = (rel: string): string =>
    read(rel)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it.each(WORKFLOWS)("%s не парсит версию из tauri.conf.json", (rel) => {
    // Ищем именно чтение поля, а не любое упоминание файла: на конфиг ссылаются
    // и по другим поводам (targets, CSP).
    expect(code(rel)).not.toMatch(
      /tauri\.conf\.json[^\n]*ConvertFrom-Json\s*\)\s*\.version/,
    );
  });

  it("скрипт смены версии существует и объявлен в package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["version:set"]).toContain("scripts/set-version.mjs");
    expect(read("scripts/set-version.mjs").startsWith("#!")).toBe(true);
  });
});
