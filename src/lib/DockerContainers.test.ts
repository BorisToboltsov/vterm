import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import DockerContainers from "./DockerContainers.svelte";
import type { ComposeGroup, DockerContainer, DockerStat } from "./docker";

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "abc123456789",
    name: "edge-proxy-canary-2",
    image: "registry.internal.example.com/platform/edge-proxy:2026.08.1",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:80->80/tcp",
    project: "",
    service: "",
    workdir: null,
    createdAt: "2026-07-19 10:00:00",
    runningFor: "2 hours",
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  const groups: ComposeGroup[] = [{ project: "", workdir: null, containers: [container()] }];
  return {
    groups,
    statsById: new Map<string, DockerStat>(),
    run: vi.fn().mockResolvedValue(true),
    onShell: vi.fn(),
    onLogs: vi.fn(),
    onInspect: vi.fn(),
    onComposeLogs: vi.fn(),
    onViewDetails: vi.fn(),
    showMenu: vi.fn(),
    ...over,
  };
}

describe("DockerContainers", () => {
  it("stacks the image under the container name instead of beside it", () => {
    // v1.0.14. Side by side, the two shared ~240px of the dock's width and a
    // compose-generated name truncated the image down to its registry host — the
    // half that says what is actually running. Block elements (not baseline-aligned
    // spans) are what puts them on separate lines.
    render(DockerContainers, { props: props() });
    const name = screen.getByText("edge-proxy-canary-2");
    const image = screen.getByText("registry.internal.example.com/platform/edge-proxy:2026.08.1");
    expect(name.tagName).toBe("DIV");
    expect(image.tagName).toBe("DIV");
    expect(image.parentElement).toBe(name.parentElement);
    expect(image.previousElementSibling).toBe(name);
  });

  it("keeps both lines truncating rather than wrapping the row taller", () => {
    // A wrapped image name would reflow the whole list on every poll.
    render(DockerContainers, { props: props() });
    for (const text of [
      "edge-proxy-canary-2",
      "registry.internal.example.com/platform/edge-proxy:2026.08.1",
    ]) {
      expect(screen.getByText(text).className).toContain("truncate");
    }
  });
});
