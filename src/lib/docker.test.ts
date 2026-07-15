import { describe, expect, it } from "vitest";
import {
  versionArgs,
  psArgs,
  imagesArgs,
  networksArgs,
  volumesArgs,
  statsArgs,
  logsArgs,
  composeLogsArgs,
  inspectArgs,
  startArgs,
  stopArgs,
  restartArgs,
  removeArgs,
  removeImageArgs,
  removeVolumeArgs,
  removeNetworkArgs,
  pruneContainersArgs,
  pruneImagesArgs,
  pruneVolumesArgs,
  pruneNetworksArgs,
  pruneSystemArgs,
  composeUpArgs,
  composeDownArgs,
  composeRestartArgs,
  execShellCommand,
  parsePs,
  parseImages,
  parseNetworks,
  parseVolumes,
  parseStats,
  groupByCompose,
  parseAvailability,
  isDestructive,
  needsConfirm,
  isRunning,
  stateTone,
  normalizeState,
  containerInfoRows,
  loginArgs,
  logoutArgs,
  registryLabel,
  sanitizeDockerRegistries,
} from "./docker";

const US = "\x1f";

/** Build a US-delimited ps row from fields (matches {@link psArgs} format order). */
function psRow(f: Partial<Record<number, string>>, count = 11): string {
  return Array.from({ length: count }, (_, i) => f[i] ?? "").join(US);
}

describe("argument builders", () => {
  it("psArgs lists all containers with compose labels in the format", () => {
    const a = psArgs();
    expect(a.slice(0, 3)).toEqual(["docker", "ps", "-a"]);
    const fmt = a[a.length - 1];
    expect(fmt).toContain("com.docker.compose.project");
    expect(fmt).toContain(US);
  });

  it("versionArgs targets the server version", () => {
    expect(versionArgs()).toEqual(["docker", "version", "--format", "{{.Server.Version}}"]);
  });

  it("logsArgs snapshots with a tail and timestamps (no follow)", () => {
    expect(logsArgs("abc", 50)).toEqual(["docker", "logs", "--tail", "50", "--timestamps", "abc"]);
    expect(logsArgs("abc")).not.toContain("-f");
  });

  it("composeLogsArgs scopes to a project", () => {
    expect(composeLogsArgs("web", 10)).toEqual([
      "docker", "compose", "-p", "web", "logs", "--tail", "10", "--timestamps", "--no-color",
    ]);
  });

  it("resource list builders are well-formed", () => {
    expect(imagesArgs().slice(0, 3)).toEqual(["docker", "images", "--format"]);
    expect(networksArgs().slice(0, 4)).toEqual(["docker", "network", "ls", "--format"]);
    expect(volumesArgs().slice(0, 4)).toEqual(["docker", "volume", "ls", "--format"]);
    expect(statsArgs()).toContain("--no-stream");
    expect(inspectArgs("x")).toEqual(["docker", "inspect", "x"]);
  });

  it("lifecycle actions carry ids and force flags", () => {
    expect(startArgs(["a", "b"])).toEqual(["docker", "start", "a", "b"]);
    expect(stopArgs(["a"])).toEqual(["docker", "stop", "a"]);
    expect(restartArgs(["a"])).toEqual(["docker", "restart", "a"]);
    expect(removeArgs(["a"])).toEqual(["docker", "rm", "a"]);
    expect(removeArgs(["a"], true)).toEqual(["docker", "rm", "-f", "a"]);
    expect(removeImageArgs(["i"], true)).toEqual(["docker", "rmi", "-f", "i"]);
    expect(removeVolumeArgs(["v"])).toEqual(["docker", "volume", "rm", "v"]);
    expect(removeNetworkArgs(["n"])).toEqual(["docker", "network", "rm", "n"]);
  });

  it("prune builders force non-interactive", () => {
    for (const a of [pruneContainersArgs(), pruneImagesArgs(), pruneVolumesArgs(), pruneNetworksArgs(), pruneSystemArgs()]) {
      expect(a).toContain("-f");
    }
  });

  it("composeUp includes the working directory when known", () => {
    expect(composeUpArgs("web", "/srv/web")).toEqual([
      "docker", "compose", "--project-directory", "/srv/web", "-p", "web", "up", "-d",
    ]);
    expect(composeUpArgs("web", null)).toEqual(["docker", "compose", "-p", "web", "up", "-d"]);
  });

  it("composeDown/Restart scope by project", () => {
    expect(composeDownArgs("web", null)).toEqual(["docker", "compose", "-p", "web", "down"]);
    expect(composeRestartArgs("web")).toEqual(["docker", "compose", "-p", "web", "restart"]);
  });

  it("execShellCommand prefers bash, falls back to sh", () => {
    const c = execShellCommand("cid");
    expect(c).toContain("docker exec -it cid");
    expect(c).toContain("exec bash");
    expect(c).toContain("exec sh");
  });
});

describe("parsers", () => {
  it("parsePs maps fields and normalizes state", () => {
    const raw =
      psRow({ 0: "abc123", 1: "web-1", 2: "nginx:latest", 3: "RUNNING", 4: "Up 2 hours", 5: "0.0.0.0:80->80/tcp", 6: "web", 7: "nginx", 8: "/srv/web", 9: "2024-01-01", 10: "2 hours ago" }) +
      "\n" +
      psRow({ 0: "def456", 1: "solo", 2: "redis", 3: "exited", 4: "Exited (0) 1 min ago" });
    const cs = parsePs(raw);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ id: "abc123", name: "web-1", state: "running", project: "web", service: "nginx", workdir: "/srv/web" });
    expect(cs[1]).toMatchObject({ id: "def456", state: "exited", project: "", workdir: null });
  });

  it("parsePs ignores blank lines", () => {
    expect(parsePs("\n\n")).toEqual([]);
  });

  it("parseImages skips id-less noise and keeps dangling images", () => {
    const raw = ["img1", "nginx", "latest", "20MB", "2 days ago"].join(US) + "\n" +
                ["img2", "<none>", "<none>", "5MB", "1 day ago"].join(US);
    const imgs = parseImages(raw);
    expect(imgs).toHaveLength(2);
    expect(imgs[1]).toMatchObject({ id: "img2", repository: "<none>", tag: "<none>" });
  });

  it("parseNetworks / parseVolumes / parseStats map fields", () => {
    expect(parseNetworks(["n1", "bridge", "bridge", "local"].join(US))[0]).toMatchObject({ name: "bridge", driver: "bridge", scope: "local" });
    expect(parseVolumes(["vol", "local"].join(US))[0]).toEqual({ name: "vol", driver: "local" });
    expect(parseStats(["c1", "web-1", "1.5%", "20MiB / 1GiB", "2%", "1kB / 2kB", "0B / 0B", "5"].join(US))[0]).toMatchObject({ cpu: "1.5%", memPerc: "2%", pids: "5" });
  });

  it("normalizeState lowercases and trims", () => {
    expect(normalizeState("  Running ")).toBe("running");
  });
});

describe("groupByCompose", () => {
  it("groups by project, standalone bucket last, workdir from first", () => {
    const cs = parsePs(
      [
        psRow({ 0: "1", 1: "solo", 3: "running" }),
        psRow({ 0: "2", 1: "web-1", 3: "running", 6: "web", 8: "/srv/web" }),
        psRow({ 0: "3", 1: "web-2", 3: "running", 6: "web" }),
        psRow({ 0: "4", 1: "api-1", 3: "running", 6: "api", 8: "/srv/api" }),
      ].join("\n"),
    );
    const groups = groupByCompose(cs);
    expect(groups.map((g) => g.project)).toEqual(["api", "web", ""]);
    const web = groups.find((g) => g.project === "web")!;
    expect(web.containers).toHaveLength(2);
    expect(web.workdir).toBe("/srv/web");
    expect(groups[groups.length - 1].project).toBe("");
  });

  it("empty input yields no groups", () => {
    expect(groupByCompose([])).toEqual([]);
  });
});

describe("parseAvailability", () => {
  it("ok with a server version", () => {
    expect(parseAvailability("24.0.7\n", "", 0)).toEqual({ ok: true, version: "24.0.7" });
  });
  it("missing binary", () => {
    const r = parseAvailability("", "docker: command not found", 127);
    expect(r).toMatchObject({ ok: false, reason: "missing" });
  });
  it("daemon down", () => {
    const r = parseAvailability("", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", 1);
    expect(r).toMatchObject({ ok: false, reason: "daemon" });
  });
  it("permission denied", () => {
    const r = parseAvailability("", "permission denied while trying to connect to the Docker daemon socket", 1);
    expect(r).toMatchObject({ ok: false, reason: "denied" });
  });
  it("unknown otherwise", () => {
    const r = parseAvailability("", "weird error", 1);
    expect(r).toMatchObject({ ok: false, reason: "unknown" });
  });
});

describe("isDestructive", () => {
  it("flags rm/rmi/prune/volume-rm/network-rm and compose down", () => {
    expect(isDestructive(removeArgs(["a"]))).toBe(true);
    expect(isDestructive(removeImageArgs(["i"]))).toBe(true);
    expect(isDestructive(pruneSystemArgs())).toBe(true);
    expect(isDestructive(pruneImagesArgs())).toBe(true);
    expect(isDestructive(removeVolumeArgs(["v"]))).toBe(true);
    expect(isDestructive(removeNetworkArgs(["n"]))).toBe(true);
    expect(isDestructive(composeDownArgs("web", null))).toBe(true);
  });
  it("does not flag reversible ops", () => {
    expect(isDestructive(startArgs(["a"]))).toBe(false);
    expect(isDestructive(stopArgs(["a"]))).toBe(false);
    expect(isDestructive(restartArgs(["a"]))).toBe(false);
    expect(isDestructive(composeUpArgs("web", null))).toBe(false);
    expect(isDestructive(logsArgs("a"))).toBe(false);
  });
});

describe("needsConfirm (Phase 36 — confirm on every server)", () => {
  it("flags every destructive op", () => {
    expect(needsConfirm(removeArgs(["a"]))).toBe(true);
    expect(needsConfirm(removeImageArgs(["i"]))).toBe(true);
    expect(needsConfirm(pruneSystemArgs())).toBe(true);
    expect(needsConfirm(composeDownArgs("web", null))).toBe(true);
  });
  it("also flags disruptive-but-reversible stop/restart", () => {
    expect(needsConfirm(stopArgs(["a"]))).toBe(true);
    expect(needsConfirm(restartArgs(["a"]))).toBe(true);
    expect(needsConfirm(composeRestartArgs("web"))).toBe(true);
    expect(needsConfirm(["docker", "kill", "a"])).toBe(true);
  });
  it("never flags start/up/logs/inspect", () => {
    expect(needsConfirm(startArgs(["a"]))).toBe(false);
    expect(needsConfirm(composeUpArgs("web", null))).toBe(false);
    expect(needsConfirm(logsArgs("a"))).toBe(false);
    expect(needsConfirm(inspectArgs("a"))).toBe(false);
  });
});

describe("containerInfoRows (Phase 36 — hover card / detail overview)", () => {
  const running = parsePs(psRow({ 0: "abc", 3: "running", 4: "Up 2h", 5: "0.0.0.0:80->80/tcp", 9: "2 days ago" }))[0];
  const stopped = parsePs(psRow({ 0: "def", 3: "exited", 4: "Exited (0) 1h ago" }))[0];

  it("includes status/ports/created and drops empty fields", () => {
    const rows = containerInfoRows(stopped);
    expect(rows.map((r) => r.key)).toEqual(["status"]);
  });
  it("adds cpu/mem/net only while running with a stat snapshot", () => {
    const stat = parseStats(["abc", "n", "1.5%", "10MiB / 1GiB", "1%", "1kB / 2kB", "0B / 0B", "3"].join(US))[0];
    const keys = containerInfoRows(running, stat).map((r) => r.key);
    expect(keys).toContain("cpu");
    expect(keys).toContain("mem");
    expect(keys).toContain("net");
    expect(keys).toContain("ports");
    // A stopped container never gets live stats even if a stale snapshot exists.
    expect(containerInfoRows(stopped, stat).some((r) => r.key === "cpu")).toBe(false);
  });
});

describe("registry auth (Phase 36)", () => {
  it("loginArgs uses --password-stdin and omits the registry for Docker Hub", () => {
    expect(loginArgs("", "bob")).toEqual(["docker", "login", "-u", "bob", "--password-stdin"]);
    expect(loginArgs("ghcr.io", "bob")).toEqual(["docker", "login", "ghcr.io", "-u", "bob", "--password-stdin"]);
  });
  it("logoutArgs omits the registry for Docker Hub", () => {
    expect(logoutArgs("")).toEqual(["docker", "logout"]);
    expect(logoutArgs("ghcr.io")).toEqual(["docker", "logout", "ghcr.io"]);
  });
  it("registryLabel names bare Docker Hub", () => {
    expect(registryLabel("")).toBe("Docker Hub");
    expect(registryLabel("  ")).toBe("Docker Hub");
    expect(registryLabel("ghcr.io")).toBe("ghcr.io");
  });
  it("sanitizeDockerRegistries drops junk, requires a username, de-dupes by url", () => {
    expect(sanitizeDockerRegistries("nope")).toEqual([]);
    expect(sanitizeDockerRegistries([{ url: "ghcr.io" }])).toEqual([]); // no username
    expect(
      sanitizeDockerRegistries([
        { url: " ghcr.io ", username: " bob " },
        { url: "ghcr.io", username: "carol" }, // same url wins (last)
        { foo: 1 },
      ]),
    ).toEqual([{ url: "ghcr.io", username: "carol" }]);
  });
});

describe("view helpers", () => {
  it("isRunning reflects state", () => {
    expect(isRunning(parsePs(psRow({ 0: "1", 3: "running" }))[0])).toBe(true);
    expect(isRunning(parsePs(psRow({ 0: "1", 3: "exited" }))[0])).toBe(false);
  });
  it("stateTone maps states to tones", () => {
    expect(stateTone("running")).toBe("ok");
    expect(stateTone("restarting")).toBe("warn");
    expect(stateTone("paused")).toBe("warn");
    expect(stateTone("dead")).toBe("bad");
    expect(stateTone("exited")).toBe("idle");
    expect(stateTone("created")).toBe("idle");
  });
});
