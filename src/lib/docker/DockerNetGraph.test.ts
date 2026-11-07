import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import DockerNetGraph from "./DockerNetGraph.svelte";
import type { DockerContainer, DockerNetwork } from "./docker";
import { GRAPH_MAX_CONTAINERS } from "./dockernet";

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

const NETWORKS = [network("bridge"), network("host", "host"), network("none", "null"), network("mon"), network("shop")];
const CONTAINERS = [
  container({ id: "w", name: "web", networks: ["mon", "shop"] }),
  container({ id: "a", name: "api", networks: ["shop"] }),
  container({ id: "p", name: "prom", networks: ["mon"] }),
  container({ id: "h", name: "agent", networks: ["host"] }),
];

const lit = () => screen.getAllByTestId("docker-net-edge").filter((e) => e.getAttribute("data-lit") === "true");
const node = (name: string) => screen.getByRole("button", { name: new RegExp(`^\\d* ?${name}`) });

describe("DockerNetGraph", () => {
  it("draws a node per network and container and an edge per membership", () => {
    render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    // host and none are modes, not networks containers meet on: no node for them.
    expect(screen.getAllByTestId("docker-net-node").map((n) => n.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "bridge 0",
      "mon 2",
      "shop 2",
    ]);
    expect(screen.getAllByTestId("docker-net-container")).toHaveLength(4);
    // web is on two networks: one node, two edges — four edges in all.
    expect(screen.getAllByTestId("docker-net-edge")).toHaveLength(4);
    expect(lit()).toHaveLength(0);
  });

  it("badges a host-mode container instead of drawing it an edge", () => {
    render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    expect(node("agent")).toHaveTextContent("host");
  });

  it("lights what a picked container shares a network with, and clears on a second click", async () => {
    render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    await fireEvent.click(node("api"));
    expect(node("api")).toHaveAttribute("aria-pressed", "true");
    // api is on shop with web: both shop edges light, mon's do not.
    expect(lit()).toHaveLength(2);
    expect(node("prom")).toHaveClass("opacity-40");
    expect(node("web")).not.toHaveClass("opacity-40");
    await fireEvent.click(node("api"));
    expect(lit()).toHaveLength(0);
    expect(node("prom")).not.toHaveClass("opacity-40");
  });

  it("lights a picked network's members", async () => {
    render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    await fireEvent.click(node("mon"));
    expect(lit()).toHaveLength(2);
    expect(node("api")).toHaveClass("opacity-40");
    expect(node("shop")).toHaveClass("opacity-40");
  });

  it("says how many containers the cap left out", () => {
    const lots = Array.from({ length: GRAPH_MAX_CONTAINERS + 3 }, (_, i) =>
      container({ id: `id${i}`, name: `c${String(i).padStart(3, "0")}`, networks: ["shop"] }),
    );
    render(DockerNetGraph, { props: { networks: [network("shop")], containers: lots } });
    expect(screen.getAllByTestId("docker-net-container")).toHaveLength(GRAPH_MAX_CONTAINERS);
    expect(screen.getByTestId("docker-net-more")).toHaveTextContent("and 3 more containers — see the list");
  });

  it("is an empty state on a host with nothing to draw", () => {
    render(DockerNetGraph, { props: { networks: [network("host", "host")], containers: [] } });
    expect(screen.getByText("No networks or containers to draw")).toBeInTheDocument();
    expect(screen.queryByTestId("docker-net-graph")).toBeNull();
  });
});

// v1.33: the topology — ports of the host, containers with their addresses,
// networks with their subnets.
describe("DockerNetGraph — topology", () => {
  const PUBLISHED = [
    container({ id: "w", name: "web", networks: ["shop"], ports: "0.0.0.0:443->443/tcp, :::443->443/tcp, 127.0.0.1:8080->80/tcp" }),
    container({ id: "a", name: "api", networks: ["shop"], ports: "8000/tcp" }),
  ];

  it("puts the published ports on the left, one per mapping, coloured by who can reach them", () => {
    render(DockerNetGraph, { props: { networks: [network("shop")], containers: PUBLISHED } });
    const ports = screen.getAllByTestId("docker-net-port");
    expect(ports.map((p) => [p.textContent?.trim(), p.dataset.reach])).toEqual([
      [":443", "all"],
      ["127.0.0.1:8080", "loopback"],
    ]);
    expect(ports[0].className).toContain("text-warn");
    expect(screen.getAllByTestId("docker-net-port-edge")).toHaveLength(2);
    expect(screen.getByText("Host ports")).toBeInTheDocument();
  });

  it("has two columns when nothing is published", () => {
    render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    expect(screen.queryByTestId("docker-net-port")).toBeNull();
    expect(screen.queryByText("Host ports")).toBeNull();
  });

  it("names each container's address and each network's subnet when it knows them", () => {
    render(DockerNetGraph, {
      props: {
        networks: [network("shop")],
        containers: PUBLISHED,
        ips: (c: DockerContainer) => (c.id === "w" ? ["172.20.0.2"] : []),
        subnets: new Map([["shop", { subnets: ["172.20.0.0/16"], internal: false }]]),
      },
    });
    expect(screen.getByTestId("docker-net-ip")).toHaveTextContent("172.20.0.2");
    expect(screen.getByTestId("docker-net-subnet")).toHaveTextContent("172.20.0.0/16");
  });

  it("a port lights its container; a node picked twice is opened where the panel can", async () => {
    const onpick = vi.fn();
    render(DockerNetGraph, { props: { networks: [network("shop")], containers: PUBLISHED, onpick } });
    await fireEvent.click(screen.getAllByTestId("docker-net-port")[0]);
    expect(node("web")).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(node("web"));
    expect(onpick).toHaveBeenCalledWith({ kind: "container", id: "w" });
  });
});

describe("DockerNetGraph — boxes (v1.33)", () => {
  it("frames a container in trouble in the colour of «Needs attention», and dashes an internal network", () => {
    render(DockerNetGraph, {
      props: {
        networks: [network("shop"), network("back")],
        containers: [container({ id: "a", name: "api", networks: ["shop", "back"] }), container({ id: "w", name: "web", networks: ["shop"] })],
        trouble: (id: string) => (id === "a" ? ("bad" as const) : null),
        subnets: new Map([["back", { subnets: ["10.9.0.0/24"], internal: true }]]),
      },
    });
    const boxes = screen.getAllByTestId("docker-net-container");
    expect(boxes.map((b) => b.dataset.trouble ?? "")).toEqual(["bad", ""]);
    expect(boxes[0].className).toContain("border-bad");
    expect(boxes[1].className).toContain("border-edge");
    const back = screen.getAllByTestId("docker-net-node").find((n) => n.textContent?.includes("back"))!;
    expect(back.className).toContain("border-dashed");
    expect(back).toHaveTextContent("10.9.0.0/24 · internal");
  });

  it("names the colours under the graph — the ports' only when there are ports", () => {
    const { unmount } = render(DockerNetGraph, { props: { networks: NETWORKS, containers: CONTAINERS } });
    const legend = screen.getByTestId("docker-net-legend");
    expect(legend).toHaveTextContent("needs attention");
    expect(legend).not.toHaveTextContent("open to all");
    unmount();
    render(DockerNetGraph, {
      props: { networks: [network("shop")], containers: [container({ id: "w", name: "web", networks: ["shop"], ports: "0.0.0.0:443->443/tcp" })] },
    });
    expect(screen.getByTestId("docker-net-legend")).toHaveTextContent("open to all");
  });

  it("puts the address on the box's second line, a dash when it is not known", () => {
    render(DockerNetGraph, {
      props: { networks: [network("shop")], containers: [container({ id: "w", name: "web", networks: ["shop"] }), container({ id: "a", name: "api", networks: ["shop"] })], ips: (c: DockerContainer) => (c.id === "w" ? ["172.20.0.2", "fd00::2"] : []) },
    });
    const [api, web] = screen.getAllByTestId("docker-net-container");
    expect(web).toHaveTextContent("172.20.0.2 · fd00::2");
    expect(api).toHaveTextContent("—");
  });
});
