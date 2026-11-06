import { describe, expect, it } from "vitest";
import { applyView, facetValues, filterItems, NO_FILTER, type ListFilter } from "../ui/listview";
import {
  type DockerStat,
  type DockerContainer,
  groupUsage,
  parseMemUsed,
  parseFacts,
  inspectFactsArgs,
  parseInspectTime,
  staleFacts,
  factsKey,
  containerAddress,
  containerHealth,
  exitCodeOf,
  stateSummary,
  dockerAttention,
  restartBaseline,
  followLogsArgv,
  FACTS_TTL_MS,
  parseContainerDetail,
  parseDiskUsage,
  parseDiskDetail,
  eventsArgs,
  parseEvents,
  eventsOf,
  eventWord,
  eventTone,
  crashLoop,
  ioPair,
  rateOf,
  resourceReadings,
  resourceKey,
  imageContainers,
  imageSchema,
  diskUsageArgs,
  diskDetailArgs,
  isSensitiveEnv,
  nanosDuration,
  healthTest,
  type DockerFacts,
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
  execShellArgv,
  parsePs,
  parseNetworkNames,
  parseImages,
  parseNetworks,
  parseVolumes,
  parseStats,
  containerSchema,
  containerState,
  CONTAINER_ORDER,
  IMAGE_ORDER,
  IMAGE_SCHEMA,
  NET_SCHEMA,
  STANDALONE,
  type DockerImage,
  parseAvailability,
  isDestructive,
  needsConfirm,
  isRunning,
  stateTone,
  normalizeState,
  containerInfoRows,
  parseDockerTime,
  dockerAge,
  dockerDate,
  loginArgs,
  logoutArgs,
  registryLabel,
  sanitizeDockerRegistries,
} from "./docker";

const US = "\x1f";

/** Build a US-delimited ps row from fields (matches {@link psArgs} format order). */
function psRow(f: Partial<Record<number, string>>, count = 12): string {
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

  it("psArgs asks for network membership last, after the fields it already had", () => {
    // Appended, not inserted: every earlier field keeps its position.
    const fields = psArgs().at(-1)!.split(US);
    expect(fields.at(-1)).toBe("{{.Networks}}");
    expect(fields).toHaveLength(12);
    expect(fields[5]).toBe("{{.Ports}}");
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
    // The timestamp, not docker's own "3 weeks ago" phrase (too wide, unlocalizable).
    expect(imagesArgs()[3]).toContain("{{.CreatedAt}}");
    expect(imagesArgs()[3]).not.toContain("CreatedSince");
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

  it("execShellArgv prefers bash, falls back to sh", () => {
    const c = execShellArgv("cid");
    expect(c.slice(0, 6)).toEqual(["docker", "exec", "-it", "cid", "sh", "-c"]);
    expect(c[6]).toContain("exec bash");
    expect(c[6]).toContain("exec sh");
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

  it("parsePs reads the networks a container is attached to", () => {
    const [two, hostMode, shared, old] = parsePs(
      [
        psRow({ 0: "1", 11: "shop_default,bridge" }),
        psRow({ 0: "2", 11: "host" }),
        // `--network container:…` shares another container's stack: docker lists none.
        psRow({ 0: "3", 11: "" }),
        // A row from before the field existed (11 fields) still parses.
        psRow({ 0: "4" }, 11),
      ].join("\n"),
    );
    expect(two.networks).toEqual(["bridge", "shop_default"]);
    expect(hostMode.networks).toEqual(["host"]);
    expect(shared.networks).toEqual([]);
    expect(old.networks).toEqual([]);
  });

  it("parseNetworkNames sorts, because docker's own order is not stable", () => {
    // The same container printed `vtp-net1,vtp-net2` created and
    // `vtp-net2,vtp-net1` exited (docker 29.2).
    expect(parseNetworkNames("vtp-net2,vtp-net1")).toEqual(parseNetworkNames("vtp-net1,vtp-net2"));
    expect(parseNetworkNames(" a , ,b ")).toEqual(["a", "b"]);
    expect(parseNetworkNames(undefined)).toEqual([]);
  });

  it("parsePs ignores blank lines", () => {
    expect(parsePs("\n\n")).toEqual([]);
  });

  it("parseImages skips id-less noise and keeps dangling images", () => {
    const raw = ["img1", "nginx", "latest", "20MB", "2026-09-12 14:03:11 +0300 MSK"].join(US) + "\n" +
                ["img2", "<none>", "<none>", "5MB", "2026-09-13 09:00:00 +0000 UTC"].join(US);
    const imgs = parseImages(raw);
    expect(imgs).toHaveLength(2);
    expect(imgs[1]).toMatchObject({ id: "img2", repository: "<none>", tag: "<none>" });
    expect(imgs[0].created).toBe("2026-09-12 14:03:11 +0300 MSK");
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

describe("container list", () => {
  const cs = parsePs(
    [
      psRow({ 0: "1", 1: "solo", 3: "running" }),
      psRow({ 0: "2", 1: "web-2", 3: "running", 4: "Up 3 days (unhealthy)", 6: "web", 8: "/srv/web" }),
      psRow({ 0: "3", 1: "web-1", 3: "exited", 6: "web" }),
      psRow({ 0: "4", 1: "api-1", 3: "running", 6: "api", 8: "/srv/api" }),
    ].join("\n"),
  );
  const cpu: Record<string, number | null> = { "1": 5, "2": 40, "3": null, "4": 12 };
  const schema = containerSchema((c) => ({ cpu: cpu[c.id], mem: null }));

  it("lies as it did: compose stacks by name, the standalone last, containers by name", () => {
    const view = applyView(cs, schema, NO_FILTER, CONTAINER_ORDER);
    expect(view.groups.map((g) => [g.key, g.rest, g.items.map((c) => c.name)])).toEqual([
      ["api", false, ["api-1"]],
      ["web", false, ["web-1", "web-2"]],
      ["", true, ["solo"]],
    ]);
  });

  it("orders by live CPU, a container without a figure last", () => {
    const view = applyView(cs, schema, NO_FILTER, { sort: { key: "cpu", dir: "desc" }, group: "none" });
    expect(view.groups[0].items.map((c) => c.name)).toEqual(["web-2", "api-1", "solo", "web-1"]);
  });

  it("tells a failing health check from running, and groups by state in lifecycle order", () => {
    expect(cs.map(containerState)).toEqual(["running", "unhealthy", "exited", "running"]);
    const view = applyView(cs, schema, NO_FILTER, { sort: { key: "name", dir: "asc" }, group: "state" });
    expect(view.groups.map((g) => g.key)).toEqual(["running", "unhealthy", "exited"]);
  });

  it("narrows by state and by project, the standalone included", () => {
    expect(facetValues(cs, schema, NO_FILTER, "compose")).toEqual([
      { value: "web", count: 2 },
      { value: "api", count: 1 },
      { value: STANDALONE, count: 1 },
    ]);
    const solo = applyView(cs, schema, { text: "", facets: { compose: [STANDALONE] } }, CONTAINER_ORDER);
    expect(solo.groups.flatMap((g) => g.items.map((c) => c.name))).toEqual(["solo"]);
    const sick = applyView(cs, schema, { text: "", facets: { state: ["unhealthy"] } }, CONTAINER_ORDER);
    expect(sick.shown).toBe(1);
  });
});

describe("image list", () => {
  const img = (repository: string, tag: string, size: string, created: string, id = repository + tag): DockerImage => ({
    id,
    repository,
    tag,
    size,
    created,
  });
  const images = [
    img("postgres", "16", "432MB", "2026-10-20 10:00:00 +0000 UTC"),
    img("<none>", "<none>", "12MB", "2026-09-01 10:00:00 +0000 UTC"),
    img("nginx", "1.27", "190MB", "2026-11-01 10:00:00 +0000 UTC"),
    img("postgres", "15", "412MB", "?"),
  ];

  it("orders by size and by time, an unknown time last", () => {
    const bySize = applyView(images, IMAGE_SCHEMA, NO_FILTER, { sort: { key: "size", dir: "desc" }, group: "none" });
    expect(bySize.groups[0].items.map((i) => `${i.repository}:${i.tag}`)).toEqual([
      "postgres:16",
      "postgres:15",
      "nginx:1.27",
      "<none>:<none>",
    ]);
    const byTime = applyView(images, IMAGE_SCHEMA, NO_FILTER, { sort: { key: "created", dir: "desc" }, group: "none" });
    expect(byTime.groups[0].items.map((i) => i.tag).at(-1)).toBe("15");
  });

  it("groups by repository, the dangling ones as the rest; the facet tells them apart", () => {
    const view = applyView(images, IMAGE_SCHEMA, NO_FILTER, { ...IMAGE_ORDER, group: "repo" });
    expect(view.groups.map((g) => [g.key, g.items.length])).toEqual([
      ["nginx", 1],
      ["postgres", 2],
      ["", 1],
    ]);
    expect(facetValues(images, IMAGE_SCHEMA, NO_FILTER, "kind")).toEqual([
      { value: "tagged", count: 3 },
      { value: "dangling", count: 1 },
    ]);
  });
});

describe("networks sub-tab filter", () => {
  it("narrows by name; a picked driver leaves the ports out", () => {
    const items = [
      { kind: "port" as const, name: "web-1" },
      { kind: "network" as const, name: "web_default", driver: "bridge" },
      { kind: "volume" as const, name: "pgdata", driver: "local" },
    ];
    const names = (f: ListFilter) => filterItems(items, NET_SCHEMA, f).map((i) => i.name);
    expect(names({ text: "web", facets: {} })).toEqual(["web-1", "web_default"]);
    expect(names({ text: "", facets: { driver: ["bridge"] } })).toEqual(["web_default"]);
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

describe("inspectFactsArgs / parseFacts", () => {
  const US = "\x1f";
  const GS = "\x1d";
  const RS = "\x1e";
  const row = (...f: string[]) => f.join(US);

  it("asks for every id in one inspect, networks as a range", () => {
    const a = inspectFactsArgs(["aaa", "bbb"]);
    expect(a.slice(0, 3)).toEqual(["docker", "inspect", "--format"]);
    expect(a.slice(-2)).toEqual(["aaa", "bbb"]);
    expect(a[3]).toContain("{{range $name, $net := .NetworkSettings.Networks}}");
    expect(a[3]).toContain("{{.RestartCount}}");
  });

  it("reads ceilings, restarts, the mode, every address and how it exited", () => {
    const nets = `shop_default${GS}172.20.0.5${GS}${RS}shop_internal${GS}10.9.0.5${GS}fd00::5${RS}`;
    const raw = [
      row("aaa", "500000000", "1073741824", "3", "shop_default", nets, "2026-11-06T10:41:02.123456789Z", "0001-01-01T00:00:00Z", "0", "false"),
      row("bbb", "0", "0", "0", "host", "", "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "137", "true"),
    ].join("\n");
    const m = parseFacts(raw);
    expect(m.get("aaa")).toEqual({
      cpuCores: 0.5,
      memBytes: 1073741824,
      restarts: 3,
      networkMode: "shop_default",
      addresses: [
        { network: "shop_default", ipv4: "172.20.0.5", ipv6: "" },
        { network: "shop_internal", ipv4: "10.9.0.5", ipv6: "fd00::5" },
      ],
      startedAt: Date.parse("2026-11-06T10:41:02.123Z"),
      finishedAt: null,
      exitCode: 0,
      oomKilled: false,
    });
    expect(m.get("bbb")).toMatchObject({ cpuCores: null, memBytes: null, networkMode: "host", addresses: [], exitCode: 137, oomKilled: true });
  });

  it("says nothing it was not told", () => {
    const m = parseFacts(row("ccc", "x", "", "", "", "", "", "", "", ""));
    expect(m.get("ccc")).toMatchObject({ cpuCores: null, memBytes: null, restarts: null, exitCode: null, startedAt: null });
  });

  it("skips junk rows instead of producing bogus entries", () => {
    expect(parseFacts(`\n${US}${US}\n`).size).toBe(0);
  });

  it("reads docker's nanosecond stamps and its zero time as never", () => {
    expect(parseInspectTime("2026-11-06T10:41:02.123456789Z")).toBe(Date.parse("2026-11-06T10:41:02.123Z"));
    expect(parseInspectTime("2026-11-06T10:41:02+03:00")).toBe(Date.parse("2026-11-06T07:41:02Z"));
    expect(parseInspectTime("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseInspectTime("junk")).toBeNull();
    expect(parseInspectTime(undefined)).toBeNull();
  });
});

const ctr = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "aaa",
  name: "shop-api-1",
  image: "shop-api:2",
  state: "running",
  status: "Up 2 hours",
  ports: "",
  project: "shop",
  service: "api",
  workdir: null,
  createdAt: "",
  runningFor: "",
  networks: ["shop_default"],
  ...over,
});
const facts = (over: Partial<DockerFacts> = {}): DockerFacts => ({
  cpuCores: null,
  memBytes: null,
  restarts: 0,
  networkMode: "shop_default",
  addresses: [{ network: "shop_default", ipv4: "172.20.0.5", ipv6: "" }],
  startedAt: null,
  finishedAt: null,
  exitCode: 0,
  oomKilled: false,
  ...over,
});

describe("staleFacts", () => {
  const now = 1_000_000;
  const entry = (c: DockerContainer, at: number) => ({ facts: facts(), key: factsKey(c), at });

  it("asks for what it never asked about", () => {
    expect(staleFacts([ctr()], new Map(), now)).toEqual(["aaa"]);
  });

  it("asks again when what ps shows changed — a start, a network", () => {
    const c = ctr();
    const cache = new Map([["aaa", entry(c, now)]]);
    expect(staleFacts([c], cache, now)).toEqual([]);
    expect(staleFacts([ctr({ state: "exited" })], cache, now)).toEqual(["aaa"]);
    expect(staleFacts([ctr({ networks: ["shop_default", "x"] })], cache, now)).toEqual(["aaa"]);
  });

  it("asks a running container again once its answer is old, a stopped one never", () => {
    const run = ctr();
    const stop = ctr({ id: "bbb", state: "exited" });
    const cache = new Map([
      ["aaa", entry(run, now)],
      ["bbb", entry(stop, now)],
    ]);
    expect(staleFacts([run, stop], cache, now + FACTS_TTL_MS - 1)).toEqual([]);
    expect(staleFacts([run, stop], cache, now + FACTS_TTL_MS)).toEqual(["aaa"]);
  });
});

describe("containerAddress", () => {
  it("shows the first address and keeps the rest", () => {
    const f = facts({ addresses: [{ network: "a", ipv4: "", ipv6: "fd00::1" }, { network: "b", ipv4: "10.0.0.2", ipv6: "" }] });
    expect(containerAddress(ctr(), f)).toEqual({ kind: "ip", first: "fd00::1", all: f.addresses });
  });

  it("names what has no address of its own", () => {
    expect(containerAddress(ctr(), facts({ networkMode: "host", addresses: [] }))).toEqual({ kind: "host" });
    expect(containerAddress(ctr(), facts({ networkMode: "none", addresses: [] }))).toEqual({ kind: "none" });
    const peer = ctr({ id: "abcdef123456", name: "vpn" });
    expect(containerAddress(ctr(), facts({ networkMode: "container:abcdef1234567890", addresses: [] }), [peer])).toEqual({ kind: "shared", with: "vpn" });
    expect(containerAddress(ctr(), facts({ networkMode: "container:0123456789abcdef0", addresses: [] }), [])).toEqual({ kind: "shared", with: "0123456789ab" });
  });

  it("tells a stopped container from an unknown answer", () => {
    expect(containerAddress(ctr({ state: "exited" }), facts({ addresses: [] }))).toEqual({ kind: "down" });
    expect(containerAddress(ctr(), facts({ addresses: [] }))).toEqual({ kind: "unknown" });
    expect(containerAddress(ctr(), undefined)).toEqual({ kind: "unknown" });
  });
});

describe("container health, exit and state cell", () => {
  it("reads the health check and the exit code from ps", () => {
    expect(containerHealth(ctr({ status: "Up 2 hours (healthy)" }))).toBe("healthy");
    expect(containerHealth(ctr({ status: "Up 2 hours (unhealthy)" }))).toBe("unhealthy");
    expect(containerHealth(ctr({ status: "Up 3 seconds (health: starting)" }))).toBe("starting");
    expect(containerHealth(ctr())).toBeNull();
    expect(exitCodeOf(ctr({ status: "Exited (1) 2 days ago" }))).toBe(1);
    expect(exitCodeOf(ctr({ status: "Up 2 hours" }))).toBeNull();
  });

  it("says the health, the exit or the state, with the time since", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const started = Date.parse("2026-11-06T10:00:00Z");
    expect(stateSummary(ctr({ status: "Up (unhealthy)" }), facts({ startedAt: started }), now)).toEqual({ word: "unhealthy", tone: "warn", age: "2h" });
    expect(stateSummary(ctr(), facts(), now)).toEqual({ word: "running", tone: "ok", age: null });
    expect(stateSummary(ctr({ state: "exited", status: "Exited (1) 1 hour ago" }), undefined, now)).toEqual({ word: "exit 1", tone: "bad", age: null });
    // A stop the user asked for is not an error.
    expect(stateSummary(ctr({ state: "exited" }), facts({ exitCode: 143 }), now).tone).toBe("idle");
    expect(stateSummary(ctr({ state: "exited" }), facts({ exitCode: 137, oomKilled: true }), now).word).toBe("OOMKilled");
    expect(stateSummary(ctr({ state: "paused" }), undefined, now)).toEqual({ word: "paused", tone: "warn", age: null });
  });
});

describe("dockerAttention", () => {
  const f = (id: string, over: Partial<DockerFacts> = {}) => [id, facts(over)] as const;

  it("lists what needs a look, worst first", () => {
    const list = [
      ctr({ id: "a", name: "a-unhealthy", status: "Up (unhealthy)" }),
      ctr({ id: "b", name: "b-dead", state: "dead" }),
      ctr({ id: "c", name: "c-failed", state: "exited", status: "Exited (2) 1 day ago" }),
      ctr({ id: "d", name: "d-stopped", state: "exited", status: "Exited (0) 1 day ago" }),
      ctr({ id: "e", name: "e-oom", state: "exited" }),
      ctr({ id: "f", name: "f-fine" }),
    ];
    const known = new Map([f("e", { exitCode: 137, oomKilled: true })]);
    const got = dockerAttention(list, known, new Map());
    expect(got.map((x) => [x.name, x.reason, x.tone])).toEqual([
      ["b-dead", "dead", "bad"],
      ["e-oom", "oom", "bad"],
      ["a-unhealthy", "unhealthy", "warn"],
      ["c-failed", "exited", "warn"],
    ]);
    expect(got.find((x) => x.reason === "exited")?.detail).toBe("exit 2");
  });

  it("lets an old exit go: a week-old crash is history, an hour-old one is news", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const list = [
      ctr({ id: "old", name: "old", state: "exited" }),
      ctr({ id: "new", name: "new", state: "exited" }),
      ctr({ id: "unk", name: "unknown-time", state: "exited", status: "Exited (2) 1 hour ago" }),
    ];
    const known = new Map([
      f("old", { exitCode: 255, finishedAt: now - 8 * 86_400_000 }),
      f("new", { exitCode: 1, finishedAt: now - 3_600_000 }),
    ]);
    expect(dockerAttention(list, known, new Map(), now).map((x) => x.name)).toEqual(["new", "unknown-time"]);
  });

  it("counts restarts only once they grow while the panel is open", () => {
    const list = [ctr({ id: "a" })];
    const seen = restartBaseline(new Map(), new Map([f("a", { restarts: 5 })]), ["a"]);
    expect(dockerAttention(list, new Map([f("a", { restarts: 5 })]), seen)).toEqual([]);
    const grown = dockerAttention(list, new Map([f("a", { restarts: 7 })]), seen);
    expect(grown).toEqual([{ id: "a", name: "shop-api-1", reason: "restarts", tone: "warn", detail: "↻+2" }]);
  });

  it("keeps the first count it saw and forgets the gone", () => {
    const first = restartBaseline(new Map(), new Map([f("a", { restarts: 1 }), f("b", { restarts: 0 })]), ["a", "b"]);
    const next = restartBaseline(first, new Map([f("a", { restarts: 9 })]), ["a"]);
    expect([...next]).toEqual([["a", 1]]);
  });
});

describe("followLogsArgv", () => {
  it("follows the log from the last lines, in a terminal", () => {
    expect(followLogsArgv("abc", 500)).toEqual(["docker", "logs", "-f", "--tail", "500", "--timestamps", "abc"]);
  });
});

describe("parseMemUsed", () => {
  it("reads the used half and ignores the right half entirely", () => {
    // The right half is the limit OR the host total — indistinguishable here.
    expect(parseMemUsed("412MiB / 1GiB")).toBe(412 * 1024 ** 2);
    expect(parseMemUsed("412MiB / 15.5GiB")).toBe(412 * 1024 ** 2);
  });

  it("handles docker's mixed binary and decimal suffixes", () => {
    expect(parseMemUsed("1.5GiB / 2GiB")).toBeCloseTo(1.5 * 1024 ** 3);
    expect(parseMemUsed("900kB / 1GB")).toBe(900 * 1000);
    expect(parseMemUsed("512B / 1GiB")).toBe(512);
  });

  it("is null for placeholders", () => {
    expect(parseMemUsed("--")).toBeNull();
    expect(parseMemUsed("")).toBeNull();
    expect(parseMemUsed(undefined)).toBeNull();
  });
});

describe("groupUsage", () => {
  const pct = (s: string | undefined) => (s ? Number(s.replace("%", "")) : null);
  const c = (id: string) =>
    ({
      id,
      name: id,
      image: "i",
      state: "running",
      status: "Up",
      ports: "",
      created: "",
      createdAt: "",
      runningFor: "",
      project: "p",
      service: "",
      workdir: null,
      networks: [],
    }) as DockerContainer;
  const stat = (id: string, cpu: string, mem: string) =>
    ({ id, name: id, cpu, mem, memPerc: "", netIo: "", blockIo: "", pids: "" }) as DockerStat;

  it("sums cpu percent and memory across the project", () => {
    const stats = new Map([
      ["a", stat("a", "10%", "100MiB / 1GiB")],
      ["b", stat("b", "5%", "50MiB / 1GiB")],
    ]);
    expect(groupUsage([c("a"), c("b")], stats, pct)).toEqual({
      cpu: 15,
      mem: 150 * 1024 ** 2,
    });
  });

  it("counts only containers that reported, and stays null when none did", () => {
    const stats = new Map([["a", stat("a", "10%", "100MiB / 1GiB")]]);
    expect(groupUsage([c("a"), c("b")], stats, pct).cpu).toBe(10);
    expect(groupUsage([c("b")], stats, pct)).toEqual({ cpu: null, mem: null });
  });

  it("is null-null for an empty project rather than a confident zero", () => {
    expect(groupUsage([], new Map(), pct)).toEqual({ cpu: null, mem: null });
  });
});

describe("docker creation time", () => {
  const now = Date.parse("2026-10-03T11:03:11Z");

  it("parses CreatedAt with a numeric offset, ignoring the zone name", () => {
    expect(parseDockerTime("2026-09-12 14:03:11 +0300 MSK")).toBe(Date.parse("2026-09-12T11:03:11Z"));
    expect(parseDockerTime("2026-09-12 06:03:11 -0500 EST")).toBe(Date.parse("2026-09-12T11:03:11Z"));
    expect(parseDockerTime("2026-09-12 16:33:11 +05:30 IST")).toBe(Date.parse("2026-09-12T11:03:11Z"));
    // podman prints fractional seconds; ISO stamps come from `inspect`.
    expect(parseDockerTime("2026-09-12 14:03:11.123456789 +0300 MSK")).toBe(Date.parse("2026-09-12T11:03:11Z"));
    expect(parseDockerTime("2026-09-12T11:03:11Z")).toBe(Date.parse("2026-09-12T11:03:11Z"));
  });

  it("reads a stamp without an offset as UTC", () => {
    expect(parseDockerTime("2026-07-19 10:00:00")).toBe(Date.parse("2026-07-19T10:00:00Z"));
  });

  it("rejects what is not a timestamp", () => {
    expect(parseDockerTime("")).toBeNull();
    expect(parseDockerTime("3 weeks ago")).toBeNull();
    expect(parseDockerTime("N/A")).toBeNull();
  });

  it("dockerAge is compact, and a dash when unknown", () => {
    expect(dockerAge("2026-09-12 14:03:11 +0300 MSK", now)).toBe("3w");
    expect(dockerAge("2026-10-03 13:03:11 +0300 MSK", now)).toBe("1h");
    expect(dockerAge("About an hour ago", now)).toBe("—");
  });

  it("dockerDate localizes the date and appends the age", () => {
    const raw = "2026-09-12 14:03:11 +0300 MSK";
    const en = dockerDate(raw, "en", now, "UTC");
    expect(en).toContain("Sep 12, 2026");
    expect(en).toContain("11:03");
    expect(en.endsWith(" · 3w")).toBe(true);
    const ru = dockerDate(raw, "ru", now, "UTC");
    expect(ru).toContain("12 сент. 2026");
    expect(ru).not.toBe(en);
  });

  it("dockerDate hands back an unreadable stamp as docker printed it", () => {
    expect(dockerDate("3 weeks ago", "en", now)).toBe("3 weeks ago");
  });
});

// Stage 1: what `docker inspect` says about a container in trouble. The fixture
// is cut from a real Docker 29 answer, with the values replaced.
const INSPECT_FIXTURE = JSON.stringify([
  {
    Id: "2b504a4d8e00",
    Path: "uvicorn",
    Args: ["app.main:app", "--host", "0.0.0.0", "--forwarded-allow-ips", "*"],
    State: {
      Status: "running",
      Health: {
        Status: "unhealthy",
        FailingStreak: 1200,
        Log: [
          { Start: "2026-11-06T21:13:30.444329969Z", End: "2026-11-06T21:13:30.7Z", ExitCode: 1, Output: "Traceback (most recent call last):\n  ...\nurllib.error.HTTPError: HTTP Error 503: Service Unavailable\n" },
          { Start: "2026-11-06T21:13:40.739114210Z", End: "2026-11-06T21:13:41Z", ExitCode: 0, Output: "" },
        ],
      },
    },
    HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
    Config: {
      Cmd: ["uvicorn"],
      Env: ["PATH=/usr/local/bin", "APP_JWT_SECRET=s3cr3t", "APP_DATABASE_URL=postgres://app:hunter2@db/app", "APP_STORAGE_KEY=k", "PYTHONUNBUFFERED=1"],
      Healthcheck: {
        Test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"],
        Interval: 10_000_000_000,
        Timeout: 3_000_000_000,
        Retries: 6,
      },
      Labels: { "com.docker.compose.service": "backend", "com.docker.compose.project": "life-e2e" },
    },
    Mounts: [
      { Type: "volume", Name: "life_storage", Source: "/var/lib/docker/volumes/life_storage/_data", Destination: "/data", RW: true },
      { Type: "bind", Source: "/srv/app/config", Destination: "/etc/app", RW: false },
    ],
  },
]);

describe("parseContainerDetail (stage 1)", () => {
  it("reads the health check and its last runs, newest first, with what each said last", () => {
    const d = parseContainerDetail(INSPECT_FIXTURE)!;
    expect(d.health).toMatchObject({
      status: "unhealthy",
      failingStreak: 1200,
      test: `python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"`,
      interval: "10s",
      timeout: "3s",
      retries: 6,
    });
    expect(d.health!.probes.map((p) => [p.exitCode, p.last])).toEqual([
      [0, ""],
      [1, "urllib.error.HTTPError: HTTP Error 503: Service Unavailable"],
    ]);
    expect(d.health!.probes[1].start).toBe(Date.parse("2026-11-06T21:13:30.444Z"));
  });

  it("reads how it is started and restarted, and what is mounted", () => {
    const d = parseContainerDetail(INSPECT_FIXTURE)!;
    expect(d.command).toBe('uvicorn app.main:app --host 0.0.0.0 --forwarded-allow-ips "*"');
    expect(d.restartPolicy).toBe("unless-stopped");
    expect(d.mounts).toEqual([
      { type: "volume", source: "life_storage", destination: "/data", readOnly: false },
      { type: "bind", source: "/srv/app/config", destination: "/etc/app", readOnly: true },
    ]);
    expect(d.labels.map((l) => l.key)).toEqual(["com.docker.compose.project", "com.docker.compose.service"]);
  });

  it("marks what looks like a secret, by name or by value", () => {
    const d = parseContainerDetail(INSPECT_FIXTURE)!;
    expect(d.env.map((e) => [e.key, e.sensitive])).toEqual([
      ["APP_DATABASE_URL", true],
      ["APP_JWT_SECRET", true],
      ["APP_STORAGE_KEY", true],
      ["PATH", false],
      ["PYTHONUNBUFFERED", false],
    ]);
    expect(isSensitiveEnv("GITHUB", "ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(isSensitiveEnv("LOG_LEVEL", "debug")).toBe(false);
  });

  it("says when there is no health check, and when the answer is not a container", () => {
    const plain = JSON.parse(INSPECT_FIXTURE);
    delete plain[0].Config.Healthcheck;
    delete plain[0].State.Health;
    plain[0].HostConfig.RestartPolicy = { Name: "on-failure", MaximumRetryCount: 5 };
    const d = parseContainerDetail(JSON.stringify(plain))!;
    expect(d.health).toBeNull();
    expect(d.restartPolicy).toBe("on-failure:5");
    expect(parseContainerDetail("Error: No such object: x")).toBeNull();
    expect(parseContainerDetail(JSON.stringify([{ Id: "img", RepoTags: ["a:b"] }]))).toBeNull();
  });

  it("prints docker's durations and health checks the way they are written", () => {
    expect(nanosDuration(10e9)).toBe("10s");
    expect(nanosDuration(90e9)).toBe("1m30s");
    expect(nanosDuration(120e9)).toBe("2m");
    expect(nanosDuration(5e8)).toBe("500ms");
    expect(nanosDuration(0)).toBeNull();
    expect(nanosDuration("x")).toBeNull();
    expect(healthTest(["CMD-SHELL", "pg_isready -U app || exit 1"])).toBe("pg_isready -U app || exit 1");
    expect(healthTest(["CMD", "curl", "-f", "http://localhost/"])).toBe("curl -f http://localhost/");
    expect(healthTest(["CMD", "sh", "-c", 'echo "$X"'])).toBe(`sh -c 'echo "$X"'`);
    expect(healthTest(["NONE"])).toBe("");
    expect(healthTest(undefined)).toBe("");
  });
});

// Stage 2: what docker takes on the disk and who uses what — real Docker 29
// answers, cut down.
const DF = [
  '{"Active":"10","Reclaimable":"2.075GB (22%)","Size":"9.182GB","TotalCount":"45","Type":"Images"}',
  '{"Active":"11","Reclaimable":"9.62MB (99%)","Size":"9.62MB","TotalCount":"22","Type":"Containers"}',
  '{"Active":"12","Reclaimable":"33.34GB (98%)","Size":"33.96GB","TotalCount":"143","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"10.55GB","Size":"13.77GB","TotalCount":"322","Type":"Build Cache"}',
].join("\n");
const DF_V = JSON.stringify({
  Images: [
    { Containers: "1", ID: "sha256:b3a3978ded91c09e74bf", Repository: "e2e-kbdint", Tag: "latest", UniqueSize: "119MB" },
    { Containers: "0", ID: "sha256:5872f763edff919d0a6d", Repository: "<none>", Tag: "<none>", UniqueSize: "31.43MB" },
  ],
  Containers: [],
  Volumes: [
    { Links: "0", Name: "e7691e94d4c1", Size: "67.3MB" },
    { Links: "2", Name: "life_storage", Size: "1.2GB" },
  ],
  BuildCache: [],
});

describe("disk usage (stage 2)", () => {
  it("asks docker itself, as JSON lines", () => {
    expect(diskUsageArgs()).toEqual(["docker", "system", "df", "--format", "{{json .}}"]);
    expect(diskDetailArgs()).toEqual(["docker", "system", "df", "-v", "--format", "{{json .}}"]);
  });

  it("reads the four rows as docker counts them, and what a prune would free", () => {
    const rows = parseDiskUsage(DF);
    expect(rows.map((r) => r.kind)).toEqual(["images", "containers", "volumes", "cache"]);
    expect(rows[2]).toEqual({ kind: "volumes", total: 143, active: 12, size: "33.96GB", reclaimable: "33.34GB", reclaimablePct: 98 });
    expect(rows[3]).toMatchObject({ reclaimable: "10.55GB", reclaimablePct: null });
    expect(parseDiskUsage("Error response from daemon\n{broken")).toEqual([]);
    expect(parseDiskUsage('{"Type":"Something new","Size":"1B"}')).toEqual([]);
  });

  it("reads who uses each image and each volume, by id and by name", () => {
    const d = parseDiskDetail(DF_V)!;
    expect(d.imageContainers.get("b3a3978ded91c09e74bf")).toBe(1);
    expect(d.volumes.get("e7691e94d4c1")).toEqual({ links: 0, size: "67.3MB" });
    expect(parseDiskDetail("nope")).toBeNull();
    const img = (id: string) => ({ id, repository: "r", tag: "t", size: "1MB", created: "" });
    expect(imageContainers(img("b3a3978ded91"), d)).toBe(1);
    expect(imageContainers(img("5872f763edff"), d)).toBe(0);
    expect(imageContainers(img("ffffffffffff"), d)).toBeNull();
    expect(imageContainers(img("b3a3978ded91"), null)).toBeNull();
  });

  it("offers the «in use» facet only once docker has said who uses what", () => {
    expect(imageSchema().facets?.map((f) => f.id)).toEqual(["kind"]);
    const d = parseDiskDetail(DF_V)!;
    const schema = imageSchema((i) => imageContainers(i, d));
    const use = (schema.facets ?? []).find((f) => f.id === "use");
    if (!use) throw new Error("the «in use» facet is missing");
    const img = (id: string) => ({ id, repository: "r", tag: "t", size: "1MB", created: "" });
    expect([use.value(img("b3a3978ded91")), use.value(img("5872f763edff")), use.value(img("ffff"))]).toEqual(["used", "unused", ""]);
  });
});

// Stage 3: what happened to the containers lately — real Docker 29 events.
const EV = (ns: string, action: string, id: string, name: string, exit = "", signal = "") =>
  [ns, action, id, name, exit, signal].join("\x1f");
const EVENTS = [
  EV("1794001113669318929", "die", "f9ab1ee05285b6af630b", "life-e2e-imaging-worker-1", "1"),
  EV("1794001113755722220", "start", "f9ab1ee05285b6af630b", "life-e2e-imaging-worker-1"),
  EV("1794001140383168719", "die", "f9ab1ee05285b6af630b", "life-e2e-imaging-worker-1", "1"),
  EV("1794001150000000000", "health_status: unhealthy", "aa11", "web"),
  EV("1794001160000000000", "kill", "aa11", "web", "", "15"),
  EV("1794001170000000000", "die", "aa11", "web", "143"),
  EV("1794001180000000000", "exec_die", "aa11", "web"),
  "junk",
].join("\n");

describe("events (stage 3)", () => {
  it("asks for a snapshot that ends, of what matters, not of every health check", () => {
    const a = eventsArgs();
    expect(a.slice(0, 6)).toEqual(["docker", "events", "--since", "10m", "--until", "0s"]);
    expect(a).toContain("event=die");
    expect(a).not.toContain("event=exec_die");
  });

  it("reads events newest first, health as its status, nanoseconds as milliseconds", () => {
    const ev = parseEvents(EVENTS);
    expect(ev).toHaveLength(6);
    expect(ev[0]).toMatchObject({ kind: "die", exitCode: 143, name: "web", at: 1794001170000 });
    expect(ev.find((e) => e.kind === "health")?.health).toBe("unhealthy");
    expect(eventsOf(ev, "f9ab1ee05285").map((e) => e.kind)).toEqual(["die", "start", "die"]);
    expect(eventsOf(ev, "")).toEqual([]);
  });

  it("says each event in docker's words, with a tone", () => {
    const ev = parseEvents(EVENTS);
    const byKind = (k: string) => ev.find((e) => e.kind === k)!;
    expect(eventWord(ev[0])).toBe("die · exit 143");
    expect(eventTone(ev[0])).toBe("idle"); // docker stop's SIGTERM
    expect(eventWord(byKind("kill"))).toBe("kill · 15");
    expect(eventWord(byKind("health"))).toBe("health · unhealthy");
    expect(eventTone(byKind("health"))).toBe("warn");
    expect(eventTone(eventsOf(ev, "f9ab")[0])).toBe("bad");
  });

  it("sees a crash loop the restart policy hides — two deaths with an error, not one, not a stop", () => {
    const ev = parseEvents(EVENTS);
    expect(crashLoop(eventsOf(ev, "f9ab"))).toEqual({ dies: 2, exitCode: 1, ooms: 0, last: 1794001140383 });
    expect(crashLoop(eventsOf(ev, "aa11"))).toBeNull();
    const looping = ctr({ id: "f9ab1ee05285", name: "life-e2e-imaging-worker-1", status: "Up 3 seconds" });
    const got = dockerAttention([looping], new Map(), new Map(), 1794001200000, ev);
    expect(got).toEqual([{ id: "f9ab1ee05285", name: "life-e2e-imaging-worker-1", reason: "crashing", tone: "bad", detail: "2× · exit 1 · 59s" }]);
  });
});

describe("resources over time (stage 3)", () => {
  it("reads docker's I/O halves and turns counters into rates", () => {
    expect(ioPair("1.2kB / 3.4MB")).toEqual([1200, 3.4e6]);
    expect(ioPair("")).toEqual([null, null]);
    expect(rateOf(1000, 3000, 2)).toBe(1000);
    expect(rateOf(null, 3000, 2)).toBeNull();
    // A counter that went back (a restart) is not a negative rate.
    expect(rateOf(3000, 1000, 2)).toBeNull();
    expect(rateOf(1000, 3000, 0)).toBeNull();
  });

  it("gives each running container its readings, rates from the previous poll, and gaps to the stopped", () => {
    const stat = (id: string, net: string): DockerStat => ({ id, name: id, cpu: "12.5%", mem: "100MiB / 1GiB", memPerc: "", netIo: net, blockIo: "0B / 2kB", pids: "1" });
    const list = [ctr({ id: "aaa" }), ctr({ id: "bbb", state: "exited" })];
    const parsePct = (v?: string) => (v ? Number.parseFloat(v) : null);
    const first = resourceReadings([stat("aaa", "1kB / 2kB")], list, new Map(), 1000, parsePct);
    expect(first.readings[resourceKey("aaa", "cpu")]).toBe(12.5);
    expect(first.readings[resourceKey("aaa", "mem")]).toBe(100 * 1024 ** 2);
    expect(first.readings[resourceKey("aaa", "rx")]).toBeNull(); // no previous poll yet
    expect(resourceKey("bbb", "cpu") in first.readings).toBe(false);
    const second = resourceReadings([stat("aaa", "3kB / 2kB")], list, first.totals, 3000, parsePct);
    expect(second.readings[resourceKey("aaa", "rx")]).toBe(1000);
    expect(second.readings[resourceKey("aaa", "tx")]).toBe(0);
  });
});
