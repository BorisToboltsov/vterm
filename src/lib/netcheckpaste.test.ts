import { describe, expect, it } from "vitest";
import { markedPieces, pasteSummary, recognize, type RuleDraft } from "./netcheckpaste";

const draft = (source: string, targets: string, ports: string, proto: "tcp" | "udp" = "tcp"): RuleDraft => ({
  source,
  targets,
  ports,
  proto,
});

/** The tokens a line marked, with their kinds. */
const marked = (text: string, line = 0) =>
  markedPieces(recognize(text).lines[line])
    .filter((p) => p.kind)
    .map((p) => `${p.kind}:${p.text}`);

describe("recognize: tables", () => {
  it("reads a sheet copied from Excel or Confluence by its header", () => {
    const text = [
      "Прошу открыть доступ для релиза 4.2:",
      "Источник\tНазначение\tПорты\tПротокол",
      "10.64.48.180 (app-01)\t10.70.39.10 (pg-master)\t5432, 6432\tTCP",
      "10.64.48.181\t10.70.39.10\t5432\tTCP",
    ].join("\n");
    const res = recognize(text);
    expect(res.rules).toEqual([
      draft("10.64.48.180 (app-01)", "10.70.39.10 (pg-master)", "5432, 6432"),
      draft("10.64.48.181", "10.70.39.10", "5432"),
    ]);
    expect(res.lines.map((l) => l.kind)).toEqual(["skipped", "header", "rule", "rule"]);
    expect(res.lines[0].notes).toEqual(["nothing"]);
    expect(pasteSummary(res)).toEqual({ rules: 2, skipped: 1, header: true, guesses: 0, noPorts: 0 });
  });

  it("maps columns by their names, in any order and with extra columns", () => {
    const text = ["№\tПорт\tIP назначения\tКомментарий\tIP источника", "1\t443\tweb.int\tфронт\t10.0.0.1"].join("\n");
    expect(recognize(text).rules).toEqual([draft("10.0.0.1", "web.int", "443")]);
  });

  it("reads Markdown and CSV tables", () => {
    const md = ["| Source | Destination | Port |", "|---|---|---|", "| app-01 | db.internal | postgres |"].join("\n");
    const res = recognize(md);
    expect(res.rules).toEqual([draft("app-01", "db.internal", "postgres")]);
    expect(res.lines[1].kind).toBe("header");
    expect(res.lines[2].notes).toEqual(["portByName"]);

    const csv = ["src;dst;port;proto", "10.0.0.1;10.0.0.5;22;tcp", "10.0.0.1;10.0.0.6;53;udp"].join("\n");
    expect(recognize(csv).rules).toEqual([draft("10.0.0.1", "10.0.0.5", "22"), draft("10.0.0.1", "10.0.0.6", "53", "udp")]);
    expect(recognize(csv).lines[2].notes).toContain("udpOnly");
  });

  it("keeps a row without ports, flagged, for the table to complete", () => {
    const res = recognize("Источник\tНазначение\n10.0.0.1\t10.0.0.5");
    expect(res.rules).toEqual([draft("10.0.0.1", "10.0.0.5", "")]);
    expect(res.lines[1].notes).toEqual(["noPorts"]);
    expect(pasteSummary(res).noPorts).toBe(1);
  });

  it("reads a name and its address in one cell as address plus note", () => {
    const res = recognize("Откуда\tКуда\tПорт\napp-01 10.0.0.1\tdb-01 (10.0.0.5)\t5432/tcp");
    expect(res.rules).toEqual([draft("10.0.0.1 (app-01)", "10.0.0.5 (db-01)", "5432")]);
  });

  it("treats 'any' as no source", () => {
    expect(recognize("Источник\tНазначение\tПорт\nany\t10.0.0.5\t443").rules).toEqual([draft("", "10.0.0.5", "443")]);
  });
});

describe("recognize: forms and arrows", () => {
  it("joins a ticket form's fields into one rule, a repeated field starts the next", () => {
    const text = [
      "Источник: 10.64.48.180",
      "Назначение: 10.70.39.10",
      "Порт: 443, 8443",
      "Описание: фронт к API",
      "Источник: 10.64.48.181",
      "Назначение: 10.70.39.11",
      "Порт: ssh",
    ].join("\n");
    const res = recognize(text);
    expect(res.rules).toEqual([draft("10.64.48.180", "10.70.39.10", "443, 8443"), draft("10.64.48.181", "10.70.39.11", "ssh")]);
    expect(res.lines.map((l) => l.rules)).toEqual([[0], [0], [0], [], [1], [1], [1]]);
  });

  it("takes canonical arrow lines through the rule parser", () => {
    const res = recognize("10.0.0.1 (gitlab), 10.0.0.2 -> 10.0.0.5:[22, 8200] (vault)\n10.0.0.1 —> db:5432");
    expect(res.rules).toEqual([
      draft("10.0.0.1, 10.0.0.2 (gitlab)", "10.0.0.5 (vault)", "22, 8200"),
      draft("10.0.0.1", "db", "5432"),
    ]);
    expect(marked("10.0.0.1 -> db:5432/tcp")).toEqual(["addr:10.0.0.1", "addr:db", "port:5432", "proto:tcp"]);
  });
});

describe("recognize: free text", () => {
  it("reads 'from … to … port …' in Russian and English", () => {
    expect(recognize("с 10.64.48.180 на vault.int.corp порт 8200").rules).toEqual([
      draft("10.64.48.180", "vault.int.corp", "8200"),
    ]);
    expect(recognize("Please open access from app-01 to db-01 on ports 5432 and 6432 (TCP)").rules).toEqual([
      draft("app-01", "db-01", "5432, 6432"),
    ]);
    expect(recognize("Нужен доступ с сервера app-01 на хост 10.0.0.5 по портам 22, 443").rules).toEqual([
      draft("app-01", "10.0.0.5", "22, 443"),
    ]);
  });

  it("takes the first of two address groups as the source, and says so", () => {
    const res = recognize("10.64.48.180   10.70.39.10   tcp 5432");
    expect(res.rules).toEqual([draft("10.64.48.180", "10.70.39.10", "5432")]);
    expect(res.lines[0].notes).toEqual(["sourceByOrder"]);
    // A comma joins a list: both are targets.
    expect(recognize("10.0.0.2, 10.0.0.3 : 22").rules).toEqual([draft("", "10.0.0.2, 10.0.0.3", "22")]);
  });

  it("reads host:port pairs, one rule each when the ports differ", () => {
    expect(recognize("10.70.39.10:22").rules).toEqual([draft("", "10.70.39.10", "22")]);
    expect(recognize("db:5432, cache:6379").rules).toEqual([draft("", "db", "5432"), draft("", "cache", "6379")]);
    expect(recognize("a.int:22, b.int:22").rules).toEqual([draft("", "a.int, b.int", "22")]);
  });

  it("takes subnets and service names, marking the guess", () => {
    const res = recognize("10.64.48.0/24 → 10.70.40.15 https");
    expect(res.rules).toEqual([draft("10.64.48.0/24", "10.70.40.15", "https")]);
    // The arrow says which side is the source — no guess about the order.
    expect(res.lines[0].notes).toEqual(["portByName"]);
    expect(recognize("Please open 10.0.0.1 to 10.0.0.5 port 443").rules).toEqual([draft("10.0.0.1", "10.0.0.5", "443")]);
    for (const arrow of ["->", "—>", "=>", "➜", "- >"]) {
      expect(recognize(`app-01 ${arrow} db.int ssh`).rules, arrow).toEqual([draft("app-01", "db.int", "ssh")]);
    }
    expect(recognize("доступ на 192.168.0.0/24 порт 22").rules).toEqual([draft("", "192.168.0.0/24", "22")]);
  });

  it("reads 443/tcp and TCP 443 alike, and ignores numbers that aren't ports", () => {
    expect(recognize("to 10.0.0.5 443/tcp").rules).toEqual([draft("", "10.0.0.5", "443")]);
    expect(recognize("to 10.0.0.5 TCP 443").rules).toEqual([draft("", "10.0.0.5", "443")]);
    const res = recognize("Заявка 2024 от 12.03.2024: на 10.0.0.5 порт 22");
    expect(res.rules).toEqual([draft("", "10.0.0.5", "22")]);
  });

  it("splits a one-line form into its fields", () => {
    expect(recognize("Источник: 10.0.0.1, Назначение: 10.0.0.5, Порт: 443").rules).toEqual([
      draft("10.0.0.1", "10.0.0.5", "443"),
    ]);
  });

  it("skips lines without an address and says why", () => {
    const res = recognize("Добрый день!\nс 10.0.0.1\n\n# комментарий");
    expect(res.rules).toEqual([]);
    expect(res.lines.map((l) => [l.kind, l.notes])).toEqual([
      ["skipped", ["nothing"]],
      ["skipped", ["noTarget"]],
      ["blank", []],
      ["blank", []],
    ]);
  });

  it("marks what it took in the original text", () => {
    expect(marked("с 10.64.48.180 на vault.int.corp порт 8200")).toEqual([
      "addr:10.64.48.180",
      "addr:vault.int.corp",
      "port:8200",
    ]);
    const pieces = markedPieces(recognize("на db.int порт 22.").lines[0]);
    expect(pieces.map((p) => p.text).join("")).toBe("на db.int порт 22.");
  });
});

describe("recognize: address order", () => {
  it("never takes an address written with a port as the source", () => {
    expect(recognize("10.64.48.180 10.70.39.10:5432").rules).toEqual([
      { source: "10.64.48.180", targets: "10.70.39.10", ports: "5432", proto: "tcp" },
    ]);
    expect(recognize("a.int:22 b.int:80").rules).toEqual([
      { source: "", targets: "a.int", ports: "22", proto: "tcp" },
      { source: "", targets: "b.int", ports: "80", proto: "tcp" },
    ]);
  });
});

describe("recognize: typos", () => {
  it("takes an out-of-range address, so the table can name the typo", () => {
    expect(recognize("10.70.39.300:22").rules).toEqual([{ source: "", targets: "10.70.39.300", ports: "22", proto: "tcp" }]);
  });
});
