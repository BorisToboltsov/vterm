import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import DockerNetworks from "./DockerNetworks.svelte";
import type { DockerContainer, DockerNetwork } from "./docker";

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

const network = (name: string, driver = "bridge"): DockerNetwork => ({ id: `id-${name}`, name, driver, scope: "local" });

function props(over: Record<string, unknown> = {}) {
  return {
    networks: [network("bridge"), network("host", "host"), network("none", "null"), network("shop_default")],
    volumes: [{ name: "pgdata", driver: "local" }],
    containers: [
      container({ id: "a", name: "api", ports: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp", networks: ["shop_default"] }),
      container({ id: "d", name: "db", ports: "127.0.0.1:5433->5432/tcp", networks: ["shop_default"] }),
      container({ id: "c", name: "cache", ports: "6379/tcp", networks: ["shop_default"] }),
      container({ id: "h", name: "agent", networks: ["host"] }),
      container({ id: "o", name: "old", state: "exited", networks: ["bridge"] }),
    ],
    run: vi.fn().mockResolvedValue(true),
    onView: vi.fn(),
    ...over,
  };
}

const portsRow = (name: string) =>
  screen.getAllByTestId("docker-ports-row").find((r) => within(r).queryByText(name))!;

describe("DockerNetworks — ports", () => {
  it("tells a port open to every interface from one bound to loopback", () => {
    render(DockerNetworks, { props: props() });
    // Same shape in `docker ps`, opposite meaning.
    expect(portsRow("api")).toHaveTextContent("8080 → 80/tcp");
    expect(within(portsRow("api")).getByTestId("docker-port-reach")).toHaveTextContent("all interfaces");
    expect(portsRow("db")).toHaveTextContent("5433 → 5432/tcp");
    expect(within(portsRow("db")).getByTestId("docker-port-reach")).toHaveTextContent("this host only");
  });

  it("says a declared-only port is not published", () => {
    render(DockerNetworks, { props: props() });
    expect(portsRow("cache")).toHaveTextContent("6379/tcp");
    expect(within(portsRow("cache")).getByTestId("docker-port-reach")).toHaveTextContent("not published");
  });

  it("lists a host-network container, which publishes nothing and listens anyway", () => {
    render(DockerNetworks, { props: props() });
    expect(portsRow("agent")).toHaveTextContent("host network: listens on the host's own interfaces, no port mapping");
  });

  it("leaves out containers with nothing to say about ports", () => {
    render(DockerNetworks, { props: props() });
    expect(screen.getAllByTestId("docker-ports-row")).toHaveLength(4);
  });

  it("shows a token it cannot parse as docker printed it, with no claim beside it", () => {
    render(DockerNetworks, { props: props({ containers: [container({ ports: "*:80->80/tcp" })] }) });
    expect(portsRow("api")).toHaveTextContent("*:80->80/tcp");
    expect(within(portsRow("api")).queryByTestId("docker-port-reach")).toBeNull();
  });

  it("warns that a stopped container's mapping has nothing behind it", () => {
    render(DockerNetworks, {
      props: props({ containers: [container({ state: "exited", ports: "0.0.0.0:80->80/tcp" })] }),
    });
    expect(portsRow("api")).toHaveTextContent("container is not running — nothing listens");
  });

  it("says so when no container has a port to show", () => {
    render(DockerNetworks, { props: props({ containers: [container()] }) });
    expect(screen.getByTestId("docker-ports-empty")).toBeInTheDocument();
  });
});

describe("DockerNetworks — membership", () => {
  const row = (name: string) =>
    screen.getAllByTestId("docker-network-row").find((r) => r.textContent?.includes(name))!;

  it("lists each network's containers under it", () => {
    render(DockerNetworks, { props: props() });
    const members = within(row("shop_default")).getAllByTestId("docker-network-member");
    expect(members.map((m) => m.textContent?.trim())).toEqual(["api", "cache", "db"]);
  });

  it("says the default bridge does not resolve names", () => {
    render(DockerNetworks, { props: props() });
    const bridge = screen.getAllByTestId("docker-network-row")[0];
    expect(bridge).toHaveTextContent("Default bridge: containers reach each other by IP, names do not resolve");
    expect(within(bridge).getByTestId("docker-network-member")).toHaveTextContent("old");
  });

  it("says host and none are modes, not networks", () => {
    render(DockerNetworks, { props: props() });
    const rows = screen.getAllByTestId("docker-network-row");
    expect(rows[1]).toHaveTextContent("Not a network: these containers use the host's own network stack");
    expect(rows[2]).toHaveTextContent("Not a network: these containers have no networking at all");
    // An empty mode is not an "empty network".
    expect(rows[2]).not.toHaveTextContent("no containers");
  });

  it("says a real network is empty when it is", () => {
    render(DockerNetworks, { props: props({ containers: [] }) });
    expect(row("shop_default")).toHaveTextContent("no containers");
  });
});

describe("DockerNetworks — view switch", () => {
  it("asks for the graph, and draws it with its caveat when told to", async () => {
    const p = props();
    const { rerender } = render(DockerNetworks, { props: p });
    expect(screen.queryByTestId("docker-net-graph")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(p.onView).toHaveBeenCalledWith("graph");
    await rerender({ ...p, view: "graph" });
    expect(screen.getByTestId("docker-net-graph")).toBeInTheDocument();
    // The one thing the graph must not be read as.
    expect(screen.getByText("A shared network: can connect in principle")).toBeInTheDocument();
    expect(screen.queryByTestId("docker-ports-row")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(p.onView).toHaveBeenLastCalledWith("list");
  });

  it("keeps the remove and prune actions of the list", async () => {
    const p = props();
    render(DockerNetworks, { props: p });
    await fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(p.run).toHaveBeenCalledWith(["docker", "network", "rm", "id-bridge"], { destructive: true, successKey: "docker.removed" });
  });
});
