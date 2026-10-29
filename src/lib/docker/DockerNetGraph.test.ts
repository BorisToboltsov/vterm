import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
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
      "0 bridge",
      "2 mon",
      "2 shop",
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
