#!/usr/bin/env node
// Плановый выпуск vterm — «поезд» (ADR 0051).
//
// Изменения копятся в main: PR пишет в верхнюю секцию CHANGELOG «## Готовится», в подсекции
// «### Новое» или «### Исправлено», и версию не трогает. Раз в неделю train.yml спрашивает
// этот скрипт, что выпускать: есть пункт в «Новое» — следующий minor, только «Исправлено» —
// следующий patch, ни одного пункта — выпуска нет. Хотфикс идёт мимо поезда, вручную, из
// ветки hotfix/* от тега.
//
//   node scripts/release-train.mjs plan                  — что выпускать (строки для $GITHUB_OUTPUT)
//   node scripts/release-train.mjs cut <версия> <дата>   — «## Готовится» → «## vX.Y.Z — дата»
//   node scripts/release-train.mjs check-pr <ветка> <база> — PR не выпускает версию сам
//   node scripts/release-train.mjs tag                   — нужен ли тег на этот коммит main
//   node scripts/release-train.mjs notes <тег> [с тега]  — «Что нового» из CHANGELOG
//   node scripts/release-train.mjs body <тег> [с тега]   — описание релиза: что нового и как запустить
//
// Решения — чистые функции ниже; их и workflow держит гейт
// src/lib/repo/releasetrain.guard.test.ts.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/BorisToboltsov/vterm";

/** Заголовок секции, куда пишут PR. Номер ей даёт выпуск. */
export const UNRELEASED = "Готовится";
/** Подсекции «Готовится» и какой выпуск они делают. */
export const KINDS = { "Новое": "minor", "Исправлено": "patch" };
/** Ветки, которым можно менять версию: PR выпуска (его открывает train.yml) и хотфикс. */
export const RELEASE_BRANCHES = ["release/", "hotfix/"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const lf = (text) => text.replace(/\r\n/g, "\n");

function parse(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`«${version}» — не версия вида major.minor.patch`);
  return m.slice(1).map(Number);
}

/** <0, 0, >0 — как у sort. */
export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Следующая версия: minor сбрасывает patch. Major поезд не поднимает никогда. */
export function bump(version, kind) {
  const [major, minor, patch] = parse(version);
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`«${kind}» — не вид выпуска (minor или patch)`);
}

/** Хвост секции без пустых строк и разделителей `---`. */
function trimmed(lines) {
  const out = [...lines];
  while (out.length && /^\s*(?:---)?\s*$/.test(out[out.length - 1])) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

/** Секции второго уровня по порядку: заголовок, версия (если это `vX.Y.Z`), текст. */
export function sectionsOf(changelog) {
  const out = [];
  for (const line of lf(changelog).split("\n")) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) out.push({ title: h[1], version: /^v(\d+\.\d+\.\d+)(?:\s|$)/.exec(h[1])?.[1] ?? null, lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out.map(({ title, version, lines }) => ({ title, version, body: trimmed(lines).join("\n") }));
}

/** Версии, у которых в CHANGELOG есть своя секция. */
export const versionsOf = (changelog) =>
  sectionsOf(changelog).flatMap((s) => (s.version ? [s.version] : []));

const brief = (line) => (line.length > 60 ? `${line.slice(0, 57)}…` : line);

/** Секция «Готовится»: пункты по видам выпуска и что в ней не так; null — секции нет. */
export function unreleasedOf(changelog) {
  const all = sectionsOf(changelog);
  const at = all.findIndex((s) => s.title === UNRELEASED);
  if (at < 0) return null;
  const problems = [];
  if (at > 0) problems.push(`«## ${UNRELEASED}» стоит ниже «## ${all[0].title}»: это первая секция`);
  if (all.filter((s) => s.title === UNRELEASED).length > 1) problems.push(`«## ${UNRELEASED}» в CHANGELOG дважды`);
  const items = { minor: [], patch: [] };
  const names = Object.keys(KINDS).map((k) => `«${k}»`).join(" или ");
  let kind; // undefined — подсекции ещё не было; null — подсекция чужая (о ней уже сказано)
  for (const line of all[at].body.split("\n")) {
    const sub = /^### (.+?)\s*$/.exec(line);
    if (sub) {
      kind = KINDS[sub[1]] ?? null;
      if (kind === null) problems.push(`«### ${sub[1]}» — подсекция не из ${names}`);
    } else if (/^- /.test(line)) {
      if (kind) items[kind].push(line.slice(2));
      else if (kind === undefined) problems.push(`пункт вне подсекции ${names}: «${brief(line)}»`);
    } else if (line.trim() && !/^\s/.test(line) && kind === undefined) {
      problems.push(`текст вне подсекции ${names}: «${brief(line)}»`);
    }
  }
  return { items, problems };
}

/** Что выпускать по расписанию: версия и вид — или почему выпуска нет. */
export function plan({ changelog, version, tags }) {
  const found = unreleasedOf(changelog);
  if (found?.problems.length) throw new Error(found.problems.join("; "));
  const minor = found?.items.minor.length ?? 0;
  const patch = found?.items.patch.length ?? 0;
  if (!minor && !patch) {
    return { release: false, reason: `в «${UNRELEASED}» нет ни одного пункта: с прошлого выпуска выпускать нечего` };
  }
  const kind = minor ? "minor" : "patch";
  const next = bump(version, kind);
  if (tags.includes(`v${next}`)) {
    throw new Error(`тег v${next} уже есть, а в main версия ${version}: сначала верните в main ветку хотфикса, из которой он вышел`);
  }
  return { release: true, version: next, kind, minor, patch };
}

/** CHANGELOG выпуска: «## Готовится» становится «## vX.Y.Z — дата», пустые подсекции уходят. */
export function cut(changelog, version, date) {
  parse(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`«${date}» — не дата вида ГГГГ-ММ-ДД`);
  const found = unreleasedOf(changelog);
  if (!found) throw new Error(`в CHANGELOG нет секции «## ${UNRELEASED}»`);
  if (found.problems.length) throw new Error(found.problems.join("; "));
  if (versionsOf(changelog).includes(version)) throw new Error(`секция v${version} в CHANGELOG уже есть`);

  const lines = lf(changelog).split("\n");
  const at = lines.findIndex((l) => new RegExp(`^## ${UNRELEASED}\\s*$`).test(l));
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  const parts = [];
  for (const line of lines.slice(at + 1, end)) {
    if (/^### /.test(line) || !parts.length) parts.push([]);
    parts.at(-1).push(line);
  }
  const kept = parts
    .map(trimmed)
    .filter((p) => p.length && !(p.length === 1 && /^### /.test(p[0])))
    .map((p) => p.join("\n"));
  const section = [`## v${version} — ${date}`, "", kept.join("\n\n"), ""];
  return [...lines.slice(0, at), ...section, ...lines.slice(end)].join("\n");
}

const demote = (body) => body.replace(/^(#{2,5}) /gm, "#$1 ");

/**
 * «Что нового» для релиза `tag`: его секция, а если последний опубликованный релиз (`since`)
 * старше — все секции после него. Пользователь, у которого `since`, видит всё, что получит.
 */
export function notes(changelog, tag, since) {
  const version = tag.replace(/^v/, "");
  parse(version);
  const all = sectionsOf(changelog).filter((s) => s.version);
  const at = all.findIndex((s) => s.version === version);
  if (at < 0) return `Список изменений — в [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md).`;
  const from = since?.replace(/^v/, "");
  const taken = [all[at]];
  if (from && SEMVER.test(from) && compare(from, version) < 0) {
    for (const s of all.slice(at + 1)) {
      if (compare(s.version, from) <= 0) break;
      taken.push(s);
    }
  }
  if (taken.length === 1) return `## Что нового в ${tag}\n\n${taken[0].body}`;
  return [`## Что нового с v${from}`, ...taken.map((s) => `### ${s.title}\n\n${demote(s.body)}`)].join("\n\n");
}

/** Как скачать и запустить — под «Что нового» в каждом релизе. */
export function instructions(tag) {
  return `Готовые сборки vterm ${tag}. Скачайте файл под свою ОС из списка **Assets** ниже.

- **macOS** — \`.dmg\`; рядом лежит \`open-on-mac.sh\` — хелпер запуска неподписанной сборки (снимает карантин Gatekeeper): \`chmod +x open-on-mac.sh && ./open-on-mac.sh\`.
- **Windows** — \`-setup.exe\` (NSIS) / \`.msi\` (установщики) и \`vterm-portable-*-x86_64.exe\` — **portable**, один файл без установки (нужен системный WebView2 Runtime); \`vterm-portable-*-x86_64-webview2.exe\` — тот же portable со встроенным WebView2 для Windows без него и без сети (LTSC).
- **Linux** — \`.deb\` / \`.rpm\` / AppImage (x86_64).

Сборки не подписаны — при первом запуске ОС может показать предупреждение; как снять, см. [docs/INSTALL.md](${REPO}/blob/main/docs/INSTALL.md).`;
}

/** Описание релиза целиком: его же показывает встроенная проверка обновлений. */
export const body = (changelog, tag, since) => `${notes(changelog, tag, since)}\n\n${instructions(tag)}\n`;

/** Что не так с PR: версию и секции версий меняет только выпуск или хотфикс. */
export function prProblems({ branch, base, head }) {
  const problems = [];
  if (!RELEASE_BRANCHES.some((prefix) => branch.startsWith(prefix))) {
    if (head.version !== base.version) {
      problems.push(`версия ${base.version} → ${head.version}: версию поднимает только выпуск (train.yml, ветка release/*) или хотфикс (hotfix/*)`);
    }
    const before = new Set(versionsOf(base.changelog));
    for (const v of versionsOf(head.changelog).filter((x) => !before.has(x))) {
      problems.push(`новая секция «## v${v}»: пиши в «## ${UNRELEASED}», номер ей даст выпуск`);
    }
  }
  problems.push(...(unreleasedOf(head.changelog)?.problems ?? []));
  return problems;
}

/**
 * Ставить ли тег на коммит main. Только на коммит, который сам поднял версию (слитый PR
 * выпуска), — не на любой, где версия без тега: иначе в выпуск попал бы PR, слитый после.
 */
export function tagDecision({ version, parentVersion, tagged, changelog }) {
  if (tagged) return { tag: null, note: `v${version} уже выпущена` };
  if (parentVersion === version) {
    return { tag: null, note: `версия ${version} без тега, но этот коммит её не поднимал — тег ставится только на коммит выпуска` };
  }
  if (!versionsOf(changelog).includes(version)) {
    throw new Error(`коммит поднял версию до ${version}, но секции «## v${version}» в CHANGELOG нет`);
  }
  return { tag: `v${version}`, note: `коммит выпуска ${version}: ставлю тег v${version}` };
}

// ── Командная строка: чтение файлов и git, решение — функции выше ─────────────

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const versionIn = (pkg) => JSON.parse(pkg).version;

function main([command, ...args]) {
  if (command === "plan") {
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const result = plan({ changelog: read("CHANGELOG.md"), version: versionIn(read("package.json")), tags });
    if (result.release) {
      process.stderr.write(`Выпуск ${result.version} (${result.kind}): пунктов «Новое» — ${result.minor}, «Исправлено» — ${result.patch}.\n`);
      process.stdout.write(`version=${result.version}\nkind=${result.kind}\n`);
    } else {
      process.stderr.write(`Выпуска нет: ${result.reason}.\n`);
      process.stdout.write("version=\nkind=\n");
    }
  } else if (command === "cut") {
    const [version, date] = args;
    writeFileSync(join(ROOT, "CHANGELOG.md"), cut(read("CHANGELOG.md"), version, date));
  } else if (command === "check-pr") {
    const [branch, baseRef] = args;
    if (!branch || !baseRef) throw new Error("Usage: check-pr <ветка PR> <коммит базы>");
    const base = { version: versionIn(git("show", `${baseRef}:package.json`)), changelog: git("show", `${baseRef}:CHANGELOG.md`) };
    const head = { version: versionIn(read("package.json")), changelog: read("CHANGELOG.md") };
    const problems = prProblems({ branch, base, head });
    for (const p of problems) process.stdout.write(`::error file=CHANGELOG.md::${p}\n`);
    if (problems.length) process.exitCode = 1;
    else process.stdout.write("Версия и секции версий не тронуты — или это выпуск.\n");
  } else if (command === "tag") {
    const version = versionIn(read("package.json"));
    const tagged = git("ls-remote", "--tags", "origin", `refs/tags/v${version}`).trim() !== "";
    const parentVersion = versionIn(git("show", "HEAD^:package.json"));
    const decision = tagDecision({ version, parentVersion, tagged, changelog: read("CHANGELOG.md") });
    process.stderr.write(`${decision.note}\n`);
    process.stdout.write(`tag=${decision.tag ?? ""}\n`);
  } else if (command === "notes" || command === "body") {
    const [tag, since] = args;
    if (!tag) throw new Error(`Usage: ${command} <тег> [последний опубликованный тег]`);
    const text = (command === "notes" ? notes : body)(read("CHANGELOG.md"), tag, since || null);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } else {
    throw new Error("Expected plan, cut, check-pr, tag, notes or body");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`✘ ${e.message}\n`);
    process.exitCode = 1;
  }
}
