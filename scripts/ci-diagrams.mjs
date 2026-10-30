#!/usr/bin/env node
// Схемы docs/CI.md — из самих workflow, а не по памяти.
//
//   pnpm ci:diagrams            пересобрать SVG из .github/workflows и ci-timing.json
//   pnpm ci:diagrams --timing   сперва взять длительности последнего зелёного релиза (gh)
//
// Картинка, которую правят руками, устаревает молча: добавили джобу — на схеме её нет,
// и никто не заметит. Поэтому джобы, триггеры и вызовы на карте прочитаны из YAML, а гейт
// `cidoc.guard` сверяет лежащие в репозитории SVG с тем, что выдаёт `renderAll`: изменился
// workflow — прогон красный, пока схему не пересоберут. Минуты времени прогона гейт не
// проверяет, они устаревают честно: на картинке стоят тег и дата.
//
// Один SVG на обе темы (`prefers-color-scheme`) и свой фон: картинка читается и там, где
// тема страницы не совпала с системной. Шрифты системные: в `<img>` веб-шрифт не загрузить.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");
const OUT_DIR = join(ROOT, "docs/diagrams");
const TIMING_FILE = join(OUT_DIR, "ci-timing.json");

// ── Что читается из workflow ────────────────────────────────────────────────────

/** Строки блока верхнего уровня `key:` — до следующего ключа нулевого отступа. */
function topBlock(yaml, key) {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const at = lines.indexOf(`${key}:`);
  if (at < 0) return [];
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    out.push(line);
  }
  return out;
}

/** Джобы workflow: id, сколько раннеров у матрицы `include` (иначе один), вызывает ли workflow. */
export function jobsOf(yaml) {
  const jobs = [];
  let inInclude = -1;
  for (const line of topBlock(yaml, "jobs")) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      jobs.push({ id: job[1], runners: 1, calls: false });
      inInclude = -1;
      continue;
    }
    if (/^ {4}uses:\s/.test(line)) jobs[jobs.length - 1].calls = true;
    const indent = line.length - line.trimStart().length;
    if (/^\s+include:\s*$/.test(line)) {
      inInclude = indent;
      jobs[jobs.length - 1].runners = 0;
    } else if (inInclude >= 0 && line.trim()) {
      if (indent <= inInclude && !line.trimStart().startsWith("-")) inInclude = -1;
      else if (line.trimStart().startsWith("- ")) jobs[jobs.length - 1].runners += 1;
    }
  }
  return jobs;
}

/** Что запускает workflow. Расписание называется на схеме «1-го числа» — и обязано им быть. */
export function triggersOf(yaml) {
  const on = topBlock(yaml, "on").join("\n");
  const cron = /cron:\s*["']?(\S+ \S+ (\S+) \S+ \S+)["']?/.exec(on);
  if (cron && cron[2] !== "1") throw new Error(`расписание «${cron[1]}» — уже не 1-го числа: поправьте схемы`);
  return {
    pr: /^\s+pull_request:/m.test(on),
    main: /^\s+push:\s*\n\s+branches:/m.test(on),
    tag: /^\s+tags:/m.test(on),
    month: !!cron,
    manual: /^\s+workflow_dispatch:/m.test(on),
  };
}

/** Какие workflow вызывает этот (`uses: ./.github/workflows/…` или `$/.github/workflows/…`). */
export const callsOf = (yaml) =>
  [...yaml.matchAll(/uses:\s*[.$]\/\.github\/workflows\/([\w.-]+\.yml)/g)].map((m) => m[1]);

/** Сколько проверок даёт CI: столько же требует ruleset `main`. */
export const requiredChecks = (ciYaml) => jobsOf(ciYaml).reduce((n, j) => n + j.runners, 0);

/** Все workflow репозитория: имя файла → текст. */
export function readWorkflows() {
  return Object.fromEntries(
    readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => [f, readFileSync(join(WORKFLOWS_DIR, f), "utf8")]),
  );
}

export const readTiming = () => JSON.parse(readFileSync(TIMING_FILE, "utf8"));

// ── Оформление ──────────────────────────────────────────────────────────────────

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;
const LIGHT = `--bg:#ffffff;--panel:#f5f7fb;--panel2:#eaeff7;--edge:#d5dde9;--text:#1b2433;--muted:#5a667b;--blue:#2f6fdb;--green:#17845a;--amber:#a56c00;--red:#c43d49;--violet:#7a4fd0;--blue-t:#2f6fdb1a;--green-t:#17845a1a;--amber-t:#a56c001a;--violet-t:#7a4fd01a;`;
const DARK = `--bg:#0b0f18;--panel:#131a28;--panel2:#1a2334;--edge:#2a3850;--text:#dbe3f0;--muted:#94a2b8;--blue:#7db3ff;--green:#5fd39a;--amber:#e6b866;--red:#f2707a;--violet:#b79cff;--blue-t:#7db3ff1f;--green-t:#5fd39a1f;--amber-t:#e6b8661f;--violet-t:#b79cff1f;`;

const c = (name) => `var(--${name})`;
const tint = (name) => `var(--${name}-t)`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function text(x, y, str, o = {}) {
  const { size = 13, weight = 400, fill = c("text"), anchor = "start", mono = false } = o;
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ` font-family="${MONO}"` : ""}>${esc(str)}</text>`;
}

function rect(x, y, w, h, o = {}) {
  const { r = 9, fill = c("panel"), stroke = c("edge"), sw = 1 } = o;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

/** Плавная связь слева направо, с наконечником в конце. */
function curve(x1, y1, x2, y2, color) {
  const mx = (x1 + x2) / 2;
  const ex = x2 - 6;
  return `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}" fill="none" stroke="${color}" stroke-width="1.8"/><polygon points="${x2},${y2} ${ex},${y2 - 4} ${ex},${y2 + 4}" fill="${color}"/>`;
}

const doc = (w, h, body, title, desc) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
:root{${LIGHT}}
@media (prefers-color-scheme: dark){:root{${DARK}}}
</style>
${rect(0.5, 0.5, w - 1, h - 1, { r: 14, fill: c("bg") })}
${body}
</svg>
`;

// ── Карта: что от чего запускается и чем кончается ──────────────────────────────

const FLOWS = [
  { file: "ci.yml", title: "CI", col: "blue" },
  { file: "security.yml", title: "Security scan", col: "amber" },
  { file: "codeql.yml", title: "CodeQL", col: "amber" },
  { file: "deep.yml", title: "Глубокие проверки", col: "violet" },
  { file: "release.yml", title: "Release", col: "green" },
];

function renderMap(workflows) {
  const W = 960, H = 452;
  const fx = 272, fw = 318, fh = 66, fgap = 16, fy0 = 28;
  const rx = fx + fw;
  const cy = (i) => fy0 + i * (fh + fgap) + fh / 2;
  const flows = FLOWS.map((f, i) => ({ ...f, i, ...triggersOf(workflows[f.file]), jobs: jobsOf(workflows[f.file]), calls: callsOf(workflows[f.file]) }));
  const hit = (test) => flows.filter(test).map((f) => f.i);
  const events = [
    { label: "PR и push в main", y: (cy(0) + cy(2)) / 2 - 16, to: hit((f) => f.pr || f.main) },
    { label: "1-го числа", y: cy(2) + 16, to: hit((f) => f.month) },
    { label: "вручную", y: cy(3) + 22, to: hit((f) => f.manual) },
    { label: "тег v*", y: cy(4), to: hit((f) => f.tag) },
  ];
  let b = "";
  const ex = 24, ew = 158;
  for (const e of events) for (const i of e.to) b += curve(ex + ew, e.y, fx, cy(i), c(flows[i].col));
  for (const e of events) {
    b += rect(ex, e.y - 21, ew, 42, { r: 21, fill: c("panel2") });
    b += text(ex + ew / 2, e.y + 5, e.label, { size: 14, weight: 600, anchor: "middle" });
  }
  for (const f of flows) {
    const y = cy(f.i) - fh / 2;
    b += rect(fx, y, fw, fh, { r: 11, stroke: c(f.col), sw: 1.4 });
    b += text(fx + 16, y + 28, f.title, { size: 16, weight: 700 });
    b += text(fx + fw - 14, y + 27, f.file, { size: 11.5, mono: true, fill: c("muted"), anchor: "end" });
    const names = f.jobs.map((j) => (j.runners > 1 ? `${j.id} ×${j.runners}` : j.id)).join(" · ");
    b += text(fx + 16, y + 50, names, { size: 10.6, mono: true, fill: c(f.col) });
  }

  // Вызов workflow целиком: пунктиром, от вызывающего вверх.
  for (const f of flows) {
    f.calls.forEach((file) => {
      const to = flows.find((x) => x.file === file);
      if (!to) throw new Error(`${f.file} вызывает ${file}, которого нет на схеме`);
      const fromY = cy(f.i) - 12 - (f.i - to.i - 1) * 5;
      const toY = cy(to.i) + (f.i - to.i > 1 ? 12 : 0);
      const bulge = 34 + (f.i - to.i - 1) * 20;
      b += `<path d="M${rx} ${fromY} C${rx + bulge} ${fromY} ${rx + bulge} ${toY} ${rx + 7} ${toY}" fill="none" stroke="${c("green")}" stroke-width="1.8" stroke-dasharray="5 4"/><polygon points="${rx},${toY} ${rx + 7},${toY - 4.5} ${rx + 7},${toY + 4.5}" fill="${c("green")}"/>`;
    });
  }
  b += text(rx + 72, cy(3) - 2, "вызывает", { size: 12.5, weight: 600, fill: c("green") });
  b += text(rx + 72, cy(3) + 14, "целиком", { size: 12.5, weight: 600, fill: c("green") });

  const ox = 730, ow = 206;
  const out = (y, title, sub, col) => {
    b += rect(ox, y - 31, ow, 62, { r: 11, fill: tint(col), stroke: "none" });
    b += text(ox + ow / 2, y - 5, title, { size: 14.5, weight: 700, fill: c(col), anchor: "middle" });
    b += text(ox + ow / 2, y + 15, sub, { size: 12, fill: c("muted"), anchor: "middle" });
  };
  const line = (y, col) => {
    b += `<line x1="${rx}" y1="${y}" x2="${ox - 6}" y2="${y}" stroke="${c(col)}" stroke-width="1.8"/><polygon points="${ox},${y} ${ox - 6},${y - 4} ${ox - 6},${y + 4}" fill="${c(col)}"/>`;
  };
  const o1 = cy(0) - 12, o2 = (cy(1) + cy(2)) / 2, o3 = cy(4) + 10;
  line(o1, "blue");
  b += curve(rx, cy(1), ox, o2 - 8, c("amber"));
  b += curve(rx, cy(2), ox, o2 + 8, c("amber"));
  line(o3, "green");
  out(o1, "Можно слить в main", "требует ruleset main", "blue");
  out(o2, "Находки в Security tab", "советуют, не останавливают", "amber");
  out(o3, "Черновик релиза", "публикует человек", "green");

  const desc = flows.map((f) => `${f.title} (${f.file}): ${f.jobs.map((j) => j.id).join(", ")}`).join("; ");
  return doc(W, H, b, "Карта пайплайнов vterm", `Что запускает пять workflow и чем они кончаются. ${desc}.`);
}

// ── Путь изменения: где его могут остановить ────────────────────────────────────

/** «5 обязательных проверок», с правильным окончанием. */
function checksLabel(n) {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} обязательная проверка`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} обязательные проверки`;
  return `${n} обязательных проверок`;
}

function renderJourney(workflows) {
  const W = 960, H = 276, y = 104;
  const x = { branch: 62, pr: 212, main: 392, tag: 556, draft: 752, release: 898 };
  let b = "";
  const seg = (a, z, col) => `<line x1="${a}" y1="${y}" x2="${z}" y2="${y}" stroke="${c(col)}" stroke-width="7" stroke-linecap="round"/>`;
  b += seg(x.branch, x.main, "blue");
  b += `<line x1="${x.main}" y1="${y}" x2="${x.tag}" y2="${y}" stroke="${c("muted")}" stroke-width="3" stroke-dasharray="3 8" stroke-linecap="round"/>`;
  b += seg(x.tag, x.release, "green");
  b += text((x.main + x.tag) / 2, y - 12, "решили выпускать", { size: 12, fill: c("muted"), anchor: "middle" });

  const label = (cx, title, sub, col) => {
    b += text(cx, y - 56, title, { size: 14, weight: 700, fill: c(col), anchor: "middle" });
    b += text(cx, y - 38, sub, { size: 12, fill: c("muted"), anchor: "middle" });
  };
  const stop = (cx, title, sub) => {
    const r = 17;
    const pts = [...Array(8)].map((_, i) => {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
    });
    b += `<polygon points="${pts.join(" ")}" fill="${c("red")}"/><rect x="${cx - 8}" y="${y - 2.5}" width="16" height="5" rx="1.5" fill="${c("bg")}"/>`;
    label(cx, title, sub, "red");
  };
  stop((x.pr + x.main) / 2, "CI", checksLabel(requiredChecks(workflows["ci.yml"])));
  stop((x.tag + x.draft) / 2, "Гейты релиза", "CI, глубокие, сборка");

  const hx = (x.draft + x.release) / 2;
  b += `<circle cx="${hx}" cy="${y}" r="17" fill="${c("green")}"/><circle cx="${hx}" cy="${y - 5}" r="5" fill="${c("bg")}"/><path d="M${hx - 9} ${y + 10} a9 8 0 0 1 18 0 z" fill="${c("bg")}"/>`;
  label(hx, "Человек", "публикует", "green");

  const stops = [["Ветка", x.branch, "blue"], ["PR", x.pr, "blue"], ["main", x.main, "blue"], ["Тег v*", x.tag, "green"], ["Черновик", x.draft, "green"], ["Релиз", x.release, "green"]];
  for (const [name, sx, col] of stops) {
    b += `<circle cx="${sx}" cy="${y}" r="10" fill="${c("bg")}" stroke="${c(col)}" stroke-width="4"/>`;
    b += text(sx, y + 34, name, { size: 14.5, weight: 650, anchor: "middle" });
  }

  const by = y + 58;
  b += rect(x.pr - 34, by, x.main - x.pr + 68, 40, { fill: tint("amber"), stroke: "none" });
  b += text((x.pr + x.main) / 2, by + 25, "Сканеры смотрят, но не держат", { size: 13, weight: 600, fill: c("amber"), anchor: "middle" });
  const my = by + 54;
  b += rect(28, my, W - 56, 40, { fill: tint("violet"), stroke: "none" });
  b += text(W / 2, my + 25, "1-го числа, без всяких изменений: глубокие проверки и сканеры ловят дрейф окружения", { size: 13, weight: 600, fill: c("violet"), anchor: "middle" });

  return doc(W, H, b, "Путь изменения от ветки до релиза", "Ветка, PR, main, тег, черновик, релиз. Останавливают CI перед main и гейты релиза перед черновиком; публикует человек. Сканеры не останавливают; раз в месяц проверки идут сами.");
}

// ── Время: настоящий прогон релиза ──────────────────────────────────────────────

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const GROUP_COLOR = { verify: "blue", deep: "violet", build: "green" };
const GROUP_TITLE = { verify: "verify", deep: "deep", build: "сборка" };

function renderTiming(timing) {
  const W = 960, lx = 176, rx = 924, max = 22, rowH = 24, top = 70;
  const px = (m) => +(lx + (m / max) * (rx - lx)).toFixed(2);
  const minutes = (v) => `${v.toFixed(1).replace(".", ",")} мин`;
  const end = timing.total;
  if (end > max) throw new Error(`прогон идёт ${end} мин — шкала рассчитана на ${max}: поправьте max`);
  const build = timing.rows.filter((r) => r.group === "build");
  const buildStart = Math.min(...build.map((r) => r.start));
  const longest = timing.rows.filter((r) => r.group === "verify" || r.group === "deep").reduce((a, r) => (r.dur > a.dur ? r : a));

  let y = top, body = "", shown;
  for (const row of timing.rows) {
    if (shown !== undefined && row.group !== shown) y += 9;
    if (GROUP_TITLE[row.group] && row.group !== shown) body += text(24, y + 15, GROUP_TITLE[row.group], { size: 11.5, weight: 700, fill: c(GROUP_COLOR[row.group]) });
    shown = row.group;
    const col = GROUP_COLOR[row.group] ?? "green";
    body += text(lx - 12, y + 16, row.label, { size: 13, anchor: "end" });
    body += `<rect x="${px(row.start)}" y="${y + 3}" width="${Math.max(3, +(px(row.start + row.dur) - px(row.start)).toFixed(2))}" height="${rowH - 7}" rx="4" fill="${c(col)}"/>`;
    if (row.dur >= 4) body += text(px(row.start + row.dur) - 8, y + 15.5, minutes(row.dur), { size: 11.5, weight: 650, fill: c("bg"), anchor: "end" });
    else if (row.start > max - 2) body += text(px(row.start) - 7, y + 16, minutes(row.dur), { size: 11.5, fill: c("muted"), anchor: "end" });
    else body += text(px(row.start + row.dur) + 7, y + 16, minutes(row.dur), { size: 11.5, fill: c("muted") });
    y += rowH;
  }
  const bottom = y + 5;
  let b = "";
  for (let m = 0; m <= 20; m += 5) {
    b += `<line x1="${px(m)}" y1="${top - 8}" x2="${px(m)}" y2="${bottom}" stroke="${c("edge")}"/>`;
    b += text(px(m), top - 15, `${m} мин`, { size: 11.5, fill: c("muted"), anchor: "middle" });
  }
  b += body;
  const dashed = (m, col) => `<line x1="${px(m)}" y1="${top - 8}" x2="${px(m)}" y2="${bottom}" stroke="${c(col)}" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  b += dashed(buildStart, "red");
  b += rect(px(buildStart) + 5, top - 4, 268, 44, { r: 4, fill: c("bg"), stroke: "none" });
  b += text(px(buildStart) + 10, top + 12, "сборка ждёт самую долгую проверку", { size: 13, weight: 650, fill: c("red") });
  b += text(px(buildStart) + 10, top + 30, `дольше всех: ${longest.label.toLowerCase()}`, { size: 12, fill: c("muted") });
  b += dashed(end, "green");
  b += text(W - 24, 26, `весь прогон: ${Math.round(end)} мин`, { size: 13.5, weight: 700, fill: c("green"), anchor: "end" });
  const [year, month, day] = timing.date.split("-").map(Number);
  const note = `Настоящий прогон release.yml для тега ${timing.tag}, ${day} ${MONTHS[month - 1]} ${year}.`;
  b += text(24, bottom + 24, note, { size: 12, fill: c("muted") });
  return doc(W, bottom + 42, b, "Сколько идёт релиз", `${note} Весь прогон ${Math.round(end)} минут: сборка ждёт самую долгую проверку, затем идёт на трёх ОС.`);
}

// ── Всё вместе ──────────────────────────────────────────────────────────────────

/** Имя файла → содержимое. Падает, если схема перестала быть правдой. */
export function renderAll({ workflows, timing }) {
  const names = Object.keys(workflows).sort();
  const known = FLOWS.map((f) => f.file).sort();
  if (names.join() !== known.join()) {
    throw new Error(`на карте ${known.join(", ")}, а в репозитории ${names.join(", ")}: дополните FLOWS`);
  }
  if (!/releaseDraft:\s*true/.test(workflows["release.yml"])) {
    throw new Error("релиз больше не черновик: схемы говорят, что публикует человек");
  }
  return {
    "ci-map.svg": renderMap(workflows),
    "ci-journey.svg": renderJourney(workflows),
    "ci-timing.svg": renderTiming(timing),
  };
}

// ── Длительности из GitHub ──────────────────────────────────────────────────────

/** Строки графика: как GitHub называет джобу и что про неё показывать. */
export const TIMING_ROWS = [
  { job: "tag", match: /^Тег = версия/, label: "Тег = версия", group: null },
  { job: "web", match: /Фронтенд/, label: "Фронтенд", group: "verify" },
  { job: "rust", match: /Rust \(Linux\)/, label: "Rust Linux", group: "verify" },
  { job: "rust", match: /Rust \(Windows\)/, label: "Rust Windows", group: "verify" },
  { job: "rust", match: /Rust \(macOS\)/, label: "Rust macOS", group: "verify" },
  { job: "deps", match: /Зависимости/, label: "Зависимости", group: "verify" },
  { job: "fuzz", match: /Фаззинг/, label: "Фаззинг", group: "deep" },
  { job: "e2e", match: /E2E/, label: "E2E", group: "deep" },
  { job: "live-sftp", match: /Живые SFTP/, label: "Живой sshd", group: "deep" },
  { job: "release", match: /^release \(macos/, label: "macOS", group: "build" },
  { job: "release", match: /^release \(windows/, label: "Windows", group: "build" },
  { job: "release", match: /^release \(ubuntu/, label: "Linux", group: "build" },
  { job: "integrity", match: /^Целостность/, label: "Целостность", group: "tail" },
];

/** Ответ `gh run view --json jobs` → данные графика. Новая джоба — ошибка, а не пропуск. */
export function timingFromRun(run, { tag, date, id }) {
  const jobs = run.jobs.filter((j) => j.startedAt && j.completedAt);
  const t0 = Math.min(...jobs.map((j) => Date.parse(j.startedAt)));
  const minutes = (ms) => Math.round((ms / 60000) * 10) / 10;
  const stray = jobs.find((j) => !TIMING_ROWS.some((r) => r.match.test(j.name)));
  if (stray) throw new Error(`«${stray.name}» нет в TIMING_ROWS: дополните график`);
  const rows = TIMING_ROWS.map(({ job, match, label, group }) => {
    const found = jobs.find((j) => match.test(j.name));
    if (!found) throw new Error(`в прогоне нет джобы «${label}»`);
    return {
      job,
      label,
      group,
      start: minutes(Date.parse(found.startedAt) - t0),
      dur: minutes(Date.parse(found.completedAt) - Date.parse(found.startedAt)),
    };
  });
  const total = minutes(Math.max(...jobs.map((j) => Date.parse(j.completedAt))) - t0);
  return { tag, date, run: id, total, rows };
}

function fetchTiming() {
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", cwd: ROOT });
  const [last] = JSON.parse(gh("run", "list", "--workflow", "release.yml", "--status", "success", "--limit", "1", "--json", "databaseId,headBranch,createdAt"));
  if (!last) throw new Error("зелёных прогонов release.yml нет");
  const run = JSON.parse(gh("run", "view", String(last.databaseId), "--json", "jobs"));
  return timingFromRun(run, { tag: last.headBranch, date: last.createdAt.slice(0, 10), id: last.databaseId });
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes("--timing")) writeFileSync(TIMING_FILE, `${JSON.stringify(fetchTiming(), null, 2)}\n`);
  for (const [name, svg] of Object.entries(renderAll({ workflows: readWorkflows(), timing: readTiming() }))) {
    writeFileSync(join(OUT_DIR, name), svg);
    console.log(`✔ docs/diagrams/${name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
