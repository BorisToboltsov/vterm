import { describe, expect, it } from "vitest";
// Written by `vterm_events.py` under a real ansible-core (2.18, Homebrew): one
// play on localhost — a command, a copy with a diff, a skipped task, a no_log
// task, a failure with ignore_errors — once with --check --diff, once applied.
import CHECK from "./ansibleevents.check.out?raw";
import APPLY from "./ansibleevents.apply.out?raw";
import { emptyRun, feedRun, findTask, firstFailure, hostFailed, hostRecap, runEnded, runHosts } from "./ansibleevents";

describe("a run read from the collector's events", () => {
  it("knows the plays, the tasks, the hosts and what each task did", () => {
    const run = feedRun(emptyRun(), CHECK);
    expect(run.file).toBe("site.yml");
    expect(run.check).toBe(true);
    expect(run.plays.map((p) => [p.name, p.tasks.map((t) => t.name), p.hosts])).toEqual([
      ["Local play", ["ok task", "changed task", "skipped", "secret", "fail"], ["local"]],
    ]);
    const [, copy, , secret] = run.plays[0].tasks;
    expect(run.cells[copy.id].local).toMatchObject({ status: "changed" });
    expect(run.cells[copy.id].local.diff).toContain("+++ after: /srv/app/out.txt");
    expect(run.cells[secret.id].local.msg).toBe("(hidden: no_log)");
    expect(runEnded(run)).toBe(true);
    expect(hostRecap(run, "local")).toMatchObject({ ok: 1, changed: 1, skipped: 4, failures: 0 });
    expect(runHosts(run)).toEqual(["local"]);
    expect(run.unread).toBe(0);
  });

  it("an ignored failure is shown, not counted as the run's", () => {
    const run = feedRun(emptyRun(), APPLY);
    const fail = run.plays[0].tasks[4];
    expect(run.cells[fail.id].local).toMatchObject({ status: "failed", ignored: true });
    expect(firstFailure(run)).toBeNull();
    expect(hostRecap(run, "local")).toMatchObject({ failures: 0, ignored: 1 });
    expect(hostFailed(hostRecap(run, "local"))).toBe(false);
    expect(findTask(run, fail.id)?.task.name).toBe("fail");
    expect(findTask(run, "nope")).toBeNull();
  });

  it("reads the file in pieces cut anywhere, and counts what is not an event", () => {
    let run = emptyRun();
    for (let i = 0; i < CHECK.length; i += 37) run = feedRun(run, CHECK.slice(i, i + 37));
    expect(run).toEqual(feedRun(emptyRun(), CHECK));
    const broken = feedRun(emptyRun(), '{"e":"start"\n[1]\n\n{"e": "play", "id": "p", "name": "P"}\n');
    expect(broken.unread).toBe(2);
    expect(broken.plays).toHaveLength(1);
  });

  it("counts a host from its cells while the run goes, and from Ansible's recap once it ended", () => {
    const lines = CHECK.split("\n").filter((l) => !l.includes('"e": "stats"')).join("\n");
    const going = feedRun(emptyRun(), lines);
    expect(runEnded(going)).toBe(false);
    expect(hostRecap(going, "local")).toMatchObject({ ok: 1, changed: 1, skipped: 4 });
    const run = feedRun(
      emptyRun(),
      [
        '{"e":"play","id":"p","name":"P"}',
        '{"e":"task","id":"t1","name":"a"}',
        '{"e":"task","id":"t1","name":"a again"}',
        '{"e":"running","host":"h","task":"t1"}',
        '{"e":"task","id":"t2","name":"b","handler":true}',
        '{"e":"result","status":"unreachable","host":"h2","task":"t2"}',
        '{"e":"result","status":"failed","host":"h","task":"t2","ignored":true}',
        '{"e":"result","status":"bogus","host":"h3","task":"t2"}',
        '{"e":"result","host":"h","task":null}',
        '{"e":"task","id":"x"}',
        "",
      ].join("\n"),
    );
    expect(run.plays[0].tasks.map((t) => [t.name, t.handler])).toEqual([["a", false], ["b", true], ["", false]]);
    expect(run.cells.t1.h.status).toBe("running");
    expect(hostRecap(run, "h")).toMatchObject({ ignored: 1, failures: 0 });
    expect(hostFailed(hostRecap(run, "h2"))).toBe(true);
    expect(hostFailed(hostRecap(run, "h"))).toBe(false);
    expect(firstFailure(run)).toEqual({ task: "t2", host: "h2" });
    expect(run.cells.t2.h3.status).toBe("running");
  });

  it("a task before any play, and a recap of nothing, change nothing", () => {
    const run = feedRun(emptyRun(), '{"e":"task","id":"t"}\n{"e":"stats","hosts":{"h":5}}\n');
    expect(run.plays).toEqual([]);
    expect(run.stats).toEqual({});
    expect(firstFailure(run)).toBeNull();
  });
});
