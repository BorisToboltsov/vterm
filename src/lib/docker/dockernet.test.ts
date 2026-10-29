import { describe, expect, it } from "vitest";
import type { DockerContainer, DockerNetwork } from "./docker";
import {
  GRAPH_MAX_CONTAINERS,
  buildNetGraph,
  containerPorts,
  graphFocus,
  isDefaultBridge,
  isSharedNetwork,
  membersByNetwork,
  parsePorts,
  portReach,
  portRows,
} from "./dockernet";

// The `Ports` field of one container, captured from docker 29.2 for
// `-p 47111:80 -p 127.0.0.1:47112:5432 -p 47113:53/udp -p 47114-47116:9000-9002
// -p [::1]:47117:81 --expose 7000` — the order and spelling are the daemon's.
const REAL_PORTS =
  "0.0.0.0:47113->53/udp, [::]:47113->53/udp, 0.0.0.0:47111->80/tcp, [::]:47111->80/tcp, " +
  "[::1]:47117->81/tcp, 127.0.0.1:47112->5432/tcp, 0.0.0.0:47114->9000/tcp, [::]:47114->9000/tcp, " +
  "0.0.0.0:47115->9001/tcp, [::]:47115->9001/tcp, 0.0.0.0:47116->9002/tcp, [::]:47116->9002/tcp";

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "c1",
    name: "api",
    image: "api:1",
    state: "running",
    status: "Up 2 hours",
    ports: "",
    project: "",
    service: "",
    workdir: null,
    createdAt: "",
    runningFor: "",
    networks: [],
    ...over,
  };
}

function network(name: string, driver = "bridge"): DockerNetwork {
  return { id: `id-${name}`, name, driver, scope: "local" };
}

describe("parsePorts", () => {
  it("reads a published IPv4 mapping", () => {
    expect(parsePorts("0.0.0.0:8080->80/tcp")).toEqual([
      { raw: "0.0.0.0:8080->80/tcp", kind: "published", hostIp: "0.0.0.0", hostPort: "8080", containerPort: "80", proto: "tcp" },
    ]);
  });

  it("reads IPv6 in both spellings docker has used", () => {
    // docker 29 brackets the address; older daemons printed `:::8080`.
    expect(parsePorts("[::]:8080->80/tcp")[0]).toMatchObject({ kind: "published", hostIp: "::", hostPort: "8080" });
    expect(parsePorts(":::8080->80/tcp")[0]).toMatchObject({ kind: "published", hostIp: "::", hostPort: "8080" });
    expect(parsePorts("[::1]:47117->81/tcp")[0]).toMatchObject({ kind: "published", hostIp: "::1" });
  });

  it("reads a declared-only port and a declared-only range", () => {
    expect(parsePorts("7000/tcp")[0]).toMatchObject({ kind: "exposed", containerPort: "7000", proto: "tcp", hostIp: "" });
    expect(parsePorts("7001-7003/tcp")[0]).toMatchObject({ kind: "exposed", containerPort: "7001-7003" });
  });

  it("reads a published range and udp", () => {
    expect(parsePorts("0.0.0.0:8000-8002->9000-9002/tcp")[0]).toMatchObject({
      kind: "published",
      hostPort: "8000-8002",
      containerPort: "9000-9002",
    });
    expect(parsePorts("0.0.0.0:53->53/udp")[0]).toMatchObject({ proto: "udp" });
  });

  it("keeps a token it does not recognize instead of dropping it", () => {
    // A Swarm service port and plain noise: neither is an address-bound mapping.
    expect(parsePorts("*:80->80/tcp, something new")).toEqual([
      { raw: "*:80->80/tcp", kind: "raw", hostIp: "", hostPort: "", containerPort: "", proto: "" },
      { raw: "something new", kind: "raw", hostIp: "", hostPort: "", containerPort: "", proto: "" },
    ]);
  });

  it("is empty for a container without ports", () => {
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts(" , ")).toEqual([]);
  });

  it("reads every token of a real daemon's field", () => {
    const ports = parsePorts(REAL_PORTS);
    expect(ports).toHaveLength(12);
    expect(ports.every((p) => p.kind === "published")).toBe(true);
  });
});

describe("portReach", () => {
  it("tells every interface from loopback from one address", () => {
    expect(portReach("0.0.0.0")).toBe("all");
    expect(portReach("::")).toBe("all");
    expect(portReach("127.0.0.1")).toBe("loopback");
    expect(portReach("127.0.1.1")).toBe("loopback");
    expect(portReach("::1")).toBe("loopback");
    expect(portReach("10.0.0.5")).toBe("address");
    expect(portReach("fd00::5")).toBe("address");
  });
});

describe("portRows", () => {
  it("shows one row for a mapping docker prints once per address family", () => {
    expect(portRows("0.0.0.0:8080->80/tcp, [::]:8080->80/tcp")).toEqual([
      {
        kind: "published",
        hostIps: ["0.0.0.0", "::"],
        hostPort: "8080",
        containerPort: "80",
        proto: "tcp",
        reach: "all",
        raw: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp",
      },
    ]);
  });

  it("never merges the same port bound with a different reach", () => {
    // Same numbers, opposite meaning: reachable from anywhere vs from this host.
    const rows = portRows("0.0.0.0:5432->5432/tcp, 127.0.0.1:5432->5432/tcp");
    expect(rows.map((r) => r.reach)).toEqual(["all", "loopback"]);
  });

  it("folds a range docker printed port by port back into one row", () => {
    const rows = portRows(REAL_PORTS);
    expect(rows.map((r) => `${r.hostPort}>${r.containerPort}/${r.proto} ${r.reach}`)).toEqual([
      "47113>53/udp all",
      "47111>80/tcp all",
      "47117>81/tcp loopback",
      "47112>5432/tcp loopback",
      "47114-47116>9000-9002/tcp all",
    ]);
  });

  it("does not fold neighbours that only look consecutive", () => {
    // Consecutive host ports onto the same container port are two mappings.
    expect(portRows("0.0.0.0:8080->80/tcp, 0.0.0.0:8081->80/tcp")).toHaveLength(2);
    // Consecutive numbers, different protocol.
    expect(portRows("0.0.0.0:53->53/tcp, 0.0.0.0:54->54/udp")).toHaveLength(2);
    // Consecutive numbers, different reach.
    expect(portRows("0.0.0.0:80->80/tcp, 127.0.0.1:81->81/tcp")).toHaveLength(2);
    // A range docker already printed as one is not extended by guesswork.
    expect(portRows("0.0.0.0:8000-8002->8000-8002/tcp, 0.0.0.0:8004->8004/tcp")).toHaveLength(2);
  });

  it("extends a range docker already folded when the next port continues it", () => {
    const [row] = portRows("0.0.0.0:8000-8002->9000-9002/tcp, 0.0.0.0:8003->9003/tcp");
    expect(row).toMatchObject({ hostPort: "8000-8003", containerPort: "9000-9003" });
  });

  it("carries declared-only and unrecognized tokens through unchanged", () => {
    expect(portRows("7000/tcp, *:80->80/tcp")).toEqual([
      { kind: "exposed", hostIps: [], hostPort: "", containerPort: "7000", proto: "tcp", reach: null, raw: "7000/tcp" },
      { kind: "raw", hostIps: [], hostPort: "", containerPort: "", proto: "", reach: null, raw: "*:80->80/tcp" },
    ]);
  });
});

describe("containerPorts", () => {
  it("lists only containers that have a port to show", () => {
    const list = containerPorts([
      container({ id: "a", ports: "127.0.0.1:5433->5432/tcp" }),
      container({ id: "b", ports: "" }),
    ]);
    expect(list.map((p) => p.container.id)).toEqual(["a"]);
    expect(list[0]).toMatchObject({ live: true, hostMode: false });
  });

  it("lists a host-network container although it publishes nothing", () => {
    // It listens on the host's interfaces directly; leaving it out would make the
    // list of what is reachable quietly incomplete.
    const [agent] = containerPorts([container({ id: "h", networks: ["host"] })]);
    expect(agent).toMatchObject({ hostMode: true, rows: [] });
  });

  it("marks the mappings of a stopped container as not live", () => {
    // docker 29 prints nothing here; a daemon that does is quoting configuration.
    const [stopped] = containerPorts([container({ state: "exited", ports: "0.0.0.0:80->80/tcp" })]);
    expect(stopped.live).toBe(false);
  });
});

describe("network kinds", () => {
  it("does not treat the host and none modes as networks containers share", () => {
    expect(isSharedNetwork("host")).toBe(false);
    expect(isSharedNetwork("none")).toBe(false);
    expect(isSharedNetwork("bridge")).toBe(true);
    expect(isSharedNetwork("shop_default")).toBe(true);
  });

  it("recognizes docker's built-in bridge and nothing else", () => {
    expect(isDefaultBridge(network("bridge"))).toBe(true);
    expect(isDefaultBridge(network("shop_default"))).toBe(false);
    expect(isDefaultBridge(network("bridge", "overlay"))).toBe(false);
  });
});

describe("membersByNetwork", () => {
  it("groups containers under every network they name, sorted by name", () => {
    const members = membersByNetwork([
      container({ id: "2", name: "web", networks: ["edge", "shop"] }),
      container({ id: "1", name: "api", networks: ["shop"] }),
      container({ id: "3", name: "lonely", networks: [] }),
    ]);
    expect(members.get("shop")?.map((c) => c.name)).toEqual(["api", "web"]);
    expect(members.get("edge")?.map((c) => c.name)).toEqual(["web"]);
    expect(members.has("")).toBe(false);
  });
});

describe("buildNetGraph", () => {
  const networks = [network("bridge"), network("host", "host"), network("none", "null"), network("shop"), network("mon")];
  const containers = [
    container({ id: "w", name: "web", networks: ["mon", "shop"] }),
    container({ id: "a", name: "api", networks: ["shop"] }),
    container({ id: "p", name: "prom", networks: ["mon"] }),
    container({ id: "h", name: "agent", networks: ["host"] }),
    container({ id: "n", name: "batch", networks: ["none"], state: "exited" }),
    container({ id: "s", name: "sidecar", networks: [] }),
  ];

  it("draws networks sorted by name and leaves the host and none modes out", () => {
    const g = buildNetGraph(networks, containers);
    expect(g.networks.map((n) => n.name)).toEqual(["bridge", "mon", "shop"]);
  });

  it("keeps each network's containers together, a network's own group beside it", () => {
    const g = buildNetGraph(networks, containers);
    // `mon` sorts before `shop`, so its containers come first; within a group, by name.
    expect(g.containers.map((c) => c.name)).toEqual(["prom", "web", "api", "agent", "batch", "sidecar"]);
    const row = Object.fromEntries(g.networks.map((n) => [n.name, n.row]));
    // bridge has no container: it takes the first free row. mon sits by prom/web.
    expect(row).toEqual({ bridge: 0, mon: 1, shop: 2 });
  });

  it("draws a container on two networks as one node with two edges", () => {
    const g = buildNetGraph(networks, containers);
    const web = g.containers.find((c) => c.name === "web")!;
    expect(g.containers.filter((c) => c.name === "web")).toHaveLength(1);
    expect(g.edges.filter((e) => e.container === web.id).map((e) => e.network)).toEqual(["mon", "shop"]);
  });

  it("gives host and none containers a mode and no edge", () => {
    const g = buildNetGraph(networks, containers);
    expect(g.containers.find((c) => c.name === "agent")).toMatchObject({ mode: "host", networks: [] });
    expect(g.containers.find((c) => c.name === "batch")).toMatchObject({ mode: "none", networks: [] });
    expect(g.containers.find((c) => c.name === "sidecar")).toMatchObject({ mode: null, networks: [] });
    expect(g.edges.some((e) => ["h", "n", "s"].includes(e.container))).toBe(false);
  });

  it("points every edge at the rows its two ends were given", () => {
    const g = buildNetGraph(networks, containers);
    for (const e of g.edges) {
      expect(e.fromRow).toBe(g.networks.find((n) => n.name === e.network)!.row);
      expect(e.toRow).toBe(g.containers.find((c) => c.id === e.container)!.row);
    }
  });

  it("is as tall as its taller column and never stacks two networks on a row", () => {
    const many = ["a", "b", "c", "d"].map((n) => network(n));
    const g = buildNetGraph(many, [container({ id: "x", name: "x", networks: ["d"] })]);
    expect(g.networks.map((n) => n.row)).toEqual([0, 1, 2, 3]);
    expect(g.rows).toBe(4);
    expect(buildNetGraph(networks, containers).rows).toBe(6);
  });

  it("places a network at the middle of its group", () => {
    const five = ["1", "2", "3", "4", "5"].map((i) => container({ id: i, name: `c${i}`, networks: ["shop"] }));
    const g = buildNetGraph([network("shop")], five);
    expect(g.networks[0]).toMatchObject({ name: "shop", row: 2, members: 5 });
  });

  it("draws a network a container names even when the listing missed it", () => {
    // `ps` and `network ls` are two snapshots; an edge must not point at nothing.
    const g = buildNetGraph([], [container({ networks: ["just-created"] })]);
    expect(g.networks.map((n) => n.name)).toEqual(["just-created"]);
    expect(g.edges).toHaveLength(1);
  });

  it("is the same graph whatever order docker listed things in", () => {
    const a = buildNetGraph(networks, containers);
    const b = buildNetGraph([...networks].reverse(), [...containers].reverse());
    expect(b).toEqual(a);
  });

  it("caps the containers it draws and says how many it left out", () => {
    const lots = Array.from({ length: GRAPH_MAX_CONTAINERS + 7 }, (_, i) =>
      container({ id: `id${i}`, name: `c${String(i).padStart(3, "0")}`, networks: ["shop"] }),
    );
    const g = buildNetGraph([network("shop")], lots);
    expect(g.containers).toHaveLength(GRAPH_MAX_CONTAINERS);
    expect(g.hidden).toBe(7);
    // The count on the network is the real one, not the drawn one.
    expect(g.networks[0].members).toBe(GRAPH_MAX_CONTAINERS + 7);
    expect(g.edges).toHaveLength(GRAPH_MAX_CONTAINERS);
  });

  it("is an empty graph for an empty host", () => {
    expect(buildNetGraph([], [])).toEqual({ networks: [], containers: [], edges: [], rows: 0, hidden: 0 });
  });
});

describe("graphFocus", () => {
  const g = buildNetGraph(
    [network("shop"), network("mon"), network("edge")],
    [
      container({ id: "w", name: "web", networks: ["mon", "shop"] }),
      container({ id: "a", name: "api", networks: ["shop"] }),
      container({ id: "p", name: "prom", networks: ["mon"] }),
      container({ id: "x", name: "proxy", networks: ["edge"] }),
    ],
  );

  it("lights a network's members", () => {
    const f = graphFocus(g, { kind: "network", name: "shop" })!;
    expect([...f.networks]).toEqual(["shop"]);
    expect([...f.containers].sort()).toEqual(["a", "w"]);
  });

  it("lights everything a container shares a network with", () => {
    const f = graphFocus(g, { kind: "container", id: "w" })!;
    expect([...f.networks].sort()).toEqual(["mon", "shop"]);
    expect([...f.containers].sort()).toEqual(["a", "p", "w"]);
  });

  it("does not reach across networks through a shared neighbour", () => {
    // api and prom both know web, but share no network themselves.
    const f = graphFocus(g, { kind: "container", id: "a" })!;
    expect([...f.containers].sort()).toEqual(["a", "w"]);
    expect(f.containers.has("x")).toBe(false);
  });

  it("is nothing without a pick, and nothing for a pick that is gone", () => {
    expect(graphFocus(g, null)).toBeNull();
    expect(graphFocus(g, { kind: "container", id: "removed" })).toBeNull();
    expect(graphFocus(g, { kind: "network", name: "removed" })).toBeNull();
  });
});
