// A playbook run as its view draws it (ADR 0071): plays, their tasks, the hosts
// as they appear, and what each task did on each host — from the JSON lines the
// collector of vterm (`vterm_events.py`) writes while Ansible runs. Read in
// pieces as the file grows; a line cut at the end of a piece waits for the
// next one. Pure: the store feeds it, the view reads it.

export type CellStatus = "running" | "ok" | "changed" | "failed" | "skipped" | "unreachable";

export interface RunCell {
  status: CellStatus;
  msg: string | null;
  diff: string | null;
  /** A failure with `ignore_errors`: shown, not counted as the run's. */
  ignored: boolean;
}

export interface RunTask {
  id: string;
  name: string;
  role: string | null;
  handler: boolean;
}

export interface RunPlay {
  id: string;
  name: string;
  tasks: RunTask[];
  /** Hosts in the order they answered in this play. */
  hosts: string[];
}

export interface HostRecap {
  ok: number;
  changed: number;
  failures: number;
  unreachable: number;
  skipped: number;
  rescued: number;
  ignored: number;
}

export interface AnsibleRun {
  file: string;
  check: boolean;
  plays: RunPlay[];
  /** `task id` → host → what it did there. */
  cells: Record<string, Record<string, RunCell>>;
  /** Ansible's recap; present once the playbook ended. */
  stats: Record<string, HostRecap> | null;
  startedAt: number | null;
  lastAt: number | null;
  /** The part of the last piece after its last line break. */
  rest: string;
  /** Lines that were not events (a broken write): counted, not guessed at. */
  unread: number;
}

export const emptyRun = (): AnsibleRun => ({
  file: "",
  check: false,
  plays: [],
  cells: {},
  stats: null,
  startedAt: null,
  lastAt: null,
  rest: "",
  unread: 0,
});

type Ev = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const STATUSES: readonly CellStatus[] = ["ok", "changed", "failed", "skipped", "unreachable"];

function recapOf(v: unknown): HostRecap | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  return { ok: n("ok"), changed: n("changed"), failures: n("failures"), unreachable: n("unreachable"), skipped: n("skipped"), rescued: n("rescued"), ignored: n("ignored") };
}

/** One event into the run. Returns the same object, changed. */
function apply(run: AnsibleRun, ev: Ev): void {
  const t = typeof ev.t === "number" ? ev.t : null;
  if (t !== null) {
    run.startedAt ??= t;
    run.lastAt = t;
  }
  const play = run.plays[run.plays.length - 1];
  switch (ev.e) {
    case "start":
      run.file = s(ev.file) ?? "";
      run.check = ev.check === true;
      break;
    case "play":
      run.plays.push({ id: s(ev.id) ?? String(run.plays.length), name: s(ev.name) ?? "", tasks: [], hosts: [] });
      break;
    case "task": {
      const id = s(ev.id);
      if (!id || !play) break;
      if (!play.tasks.some((x) => x.id === id)) {
        play.tasks.push({ id, name: s(ev.name) ?? "", role: s(ev.role), handler: ev.handler === true });
      }
      break;
    }
    case "running":
    case "result":
    case "diff": {
      const host = s(ev.host);
      const task = s(ev.task);
      if (!host || !task) break;
      const owner = run.plays.find((p) => p.tasks.some((x) => x.id === task)) ?? play;
      if (owner && !owner.hosts.includes(host)) owner.hosts.push(host);
      const row = (run.cells[task] ??= {});
      const cell = (row[host] ??= { status: "running", msg: null, diff: null, ignored: false });
      if (ev.e === "result") {
        const st = s(ev.status) as CellStatus | null;
        if (st && STATUSES.includes(st)) cell.status = st;
        cell.msg = s(ev.msg);
        cell.ignored = ev.ignored === true;
      } else if (ev.e === "diff") {
        const d = s(ev.diff);
        if (d) cell.diff = (cell.diff ? `${cell.diff}\n` : "") + d.replace(ANSI, "");
      }
      break;
    }
    case "stats": {
      const out: Record<string, HostRecap> = {};
      const hosts = ev.hosts && typeof ev.hosts === "object" ? (ev.hosts as Record<string, unknown>) : {};
      for (const [h, v] of Object.entries(hosts)) {
        const r = recapOf(v);
        if (r) out[h] = r;
      }
      run.stats = out;
      break;
    }
  }
}

/** The run after `chunk` — the next piece of the events file. A new object; the old one is left as it was. */
export function feedRun(prev: AnsibleRun, chunk: string): AnsibleRun {
  const run: AnsibleRun = structuredClone(prev);
  const text = run.rest + chunk;
  const lines = text.split("\n");
  run.rest = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      run.unread++;
      continue;
    }
    if (ev && typeof ev === "object" && !Array.isArray(ev)) apply(run, ev as Ev);
    else run.unread++;
  }
  return run;
}

/** Whether the playbook has ended (Ansible wrote its recap). */
export const runEnded = (run: AnsibleRun): boolean => run.stats !== null;

/** The hosts of the whole run, in the order they first answered. */
export function runHosts(run: AnsibleRun): string[] {
  const out: string[] = [];
  for (const p of run.plays) for (const h of p.hosts) if (!out.includes(h)) out.push(h);
  return out;
}

/** How a host did, counted from the cells while the run goes; Ansible's recap once it ended. */
export function hostRecap(run: AnsibleRun, host: string): HostRecap {
  if (run.stats?.[host]) return run.stats[host];
  const r: HostRecap = { ok: 0, changed: 0, failures: 0, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 };
  for (const row of Object.values(run.cells)) {
    const c = row[host];
    if (!c) continue;
    if (c.status === "ok") r.ok++;
    else if (c.status === "changed") {
      r.ok++;
      r.changed++;
    } else if (c.status === "failed") {
      if (c.ignored) r.ignored++;
      else r.failures++;
    } else if (c.status === "unreachable") r.unreachable++;
    else if (c.status === "skipped") r.skipped++;
  }
  return r;
}

/** Whether a host failed or was not reached in the run. */
export const hostFailed = (r: HostRecap): boolean => r.failures > 0 || r.unreachable > 0;

/** The first cell that failed (not ignored): what the view opens on when the run ends. */
export function firstFailure(run: AnsibleRun): { task: string; host: string } | null {
  for (const p of run.plays)
    for (const t of p.tasks)
      for (const h of p.hosts) {
        const c = run.cells[t.id]?.[h];
        if (c && (c.status === "unreachable" || (c.status === "failed" && !c.ignored))) return { task: t.id, host: h };
      }
  return null;
}

/** The task with this id, and its play. */
export function findTask(run: AnsibleRun, id: string): { play: RunPlay; task: RunTask } | null {
  for (const play of run.plays) {
    const task = play.tasks.find((t) => t.id === id);
    if (task) return { play, task };
  }
  return null;
}
