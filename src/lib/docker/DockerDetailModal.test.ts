import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DockerDetailModal from "./DockerDetailModal.svelte";
import type { ContainerEvent, DockerContainer } from "./docker";

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "abc123456789",
    name: "web",
    image: "nginx:1.27",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:80->80/tcp",
    project: "",
    service: "",
    workdir: null,
    createdAt: "2026-07-19 10:00:00",
    runningFor: "2 hours",
    networks: [],
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    container: container(),
    busy: false,
    refreshSec: 3,
    run: vi.fn().mockResolvedValue(true),
    runQuery: vi.fn().mockResolvedValue({ stdout: "log line", stderr: "", code: 0 }),
    onShell: vi.fn(),
    onclose: vi.fn(),
    ...over,
  };
}

describe("DockerDetailModal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on the log — what a container is opened for (v1.33)", async () => {
    render(DockerDetailModal, { props: props() });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();
    expect(screen.getByTestId("docker-text").textContent).toContain("log line");
    expect(screen.getByTestId("docker-log-tools")).toBeTruthy();
  });

  it("stays on the chosen tab when the poll hands over a fresh object for the same container", async () => {
    const { rerender } = render(DockerDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-text").textContent).toContain("log line");

    // What the panel does every `refreshSec`: same container, new object (and a
    // changed status line). Must not count as "a different container".
    await rerender({ container: container({ status: "Up 3 hours" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();
    expect(screen.getByTestId("docker-text").textContent).toContain("log line");
  });

  it("keeps the view and fetches anew when a different container is opened", async () => {
    // v1.33: the list beside the details is browsed — the next row's log, not
    // a jump back to Overview on every pick.
    const p = props();
    const { rerender } = render(DockerDetailModal, { props: p });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-inspect"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();

    await rerender({ container: container({ id: "def987654321", name: "db" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();
    expect(p.runQuery.mock.calls.at(-1)?.[0]).toEqual(["docker", "inspect", "def987654321"]);
  });

  it("holds a paused log still and asks for more lines when told to", async () => {
    const p = props();
    render(DockerDetailModal, { props: p });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByTestId("docker-log-live"));
    const held = p.runQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(p.runQuery.mock.calls.length).toBe(held);
    await fireEvent.change(screen.getByTestId("docker-log-tail"), { target: { value: "1000" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.runQuery.mock.calls.at(-1)?.[0]).toEqual(["docker", "logs", "--tail", "1000", "--timestamps", "abc123456789"]);
  });

  it("keeps exactly one logs poller alive across snapshots", async () => {
    const p = props();
    const { rerender } = render(DockerDetailModal, { props: p });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);

    await rerender({ container: container({ status: "Up 3 hours" }) });
    await vi.advanceTimersByTimeAsync(0);
    const before = p.runQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    // One tick per interval — a stacked second interval would double this.
    expect(p.runQuery.mock.calls.length).toBe(before + 1);
  });
});

// A real Docker 29 `inspect` answer, cut down, values replaced (the model's own
// test reads the same shape in docker.test.ts).
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

describe("DockerDetailModal — Overview reads the container (stage 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const withInspect = () =>
    props({
      runQuery: vi.fn(async (args: string[]) =>
        args[1] === "inspect" ? { stdout: INSPECT_FIXTURE, stderr: "", exitCode: 0 } : { stdout: "log line", stderr: "", exitCode: 0 },
      ),
    });

  it("shows the failing health check with what its runs said, the command and the mounts", async () => {
    render(DockerDetailModal, { props: { ...withInspect(), tab: "overview" } });
    await vi.advanceTimersByTimeAsync(0);
    const health = screen.getByTestId("docker-detail-health");
    expect(health).toHaveTextContent("unhealthy");
    expect(health).toHaveTextContent("failed 1200 times in a row");
    expect(screen.getByTestId("docker-detail-probes")).toHaveTextContent("HTTP Error 503: Service Unavailable");
    expect(screen.getByTestId("docker-detail-command")).toHaveTextContent("uvicorn app.main:app");
    expect(screen.getByTestId("docker-detail-mounts")).toHaveTextContent("read-only");
  });

  it("masks what looks like a secret until asked, and asks again for the next container", async () => {
    const p = withInspect();
    const { rerender } = render(DockerDetailModal, { props: { ...p, tab: "overview" } });
    await vi.advanceTimersByTimeAsync(0);
    const env = screen.getByTestId("docker-detail-env");
    expect(env).not.toHaveTextContent("s3cr3t");
    expect(env).not.toHaveTextContent("hunter2");
    expect(env).toHaveTextContent("‹redacted›");
    expect(env).toHaveTextContent("/usr/local/bin");
    await fireEvent.click(screen.getByTestId("docker-detail-env-reveal"));
    expect(env).toHaveTextContent("s3cr3t");
    await rerender({ container: container({ id: "def987654321", name: "db" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-detail-env")).not.toHaveTextContent("s3cr3t");
  });

  it("tells the assistant what the health check said — and never the environment", async () => {
    const onAsk = vi.fn();
    render(DockerDetailModal, { props: { ...withInspect(), tab: "overview", onAsk } });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByTestId("docker-ask-ai"));
    const context = onAsk.mock.calls[0][0] as string;
    expect(context).toContain("HTTP Error 503");
    for (const secret of ["s3cr3t", "hunter2", "APP_JWT_SECRET", "/usr/local/bin"]) expect(context).not.toContain(secret);
  });

  it("re-reads it on every poll, and says so when the answer cannot be read", async () => {
    const p = props({ runQuery: vi.fn().mockResolvedValue({ stdout: "Error: No such object", stderr: "", exitCode: 1 }) });
    render(DockerDetailModal, { props: { ...p, tab: "overview" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-detail-unread")).toBeInTheDocument();
    const asked = p.runQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.runQuery.mock.calls.length).toBe(asked + 1);
  });
});

describe("DockerDetailModal — resources and events (stage 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hist = {
    "abc123456789.cpu": [{ s: 0, v: 10 }, { s: 1, v: 30 }],
    "abc123456789.mem": [{ s: 0, v: 200 * 1024 ** 2 }, { s: 1, v: 210 * 1024 ** 2 }],
  };
  const facts = (over: Record<string, unknown> = {}) => ({
    cpuCores: 0.5, memBytes: 1024 ** 3, restarts: 0, networkMode: "bridge", addresses: [], startedAt: null, finishedAt: null, exitCode: null, oomKilled: false, ports: "", ...over,
  });

  it("draws CPU and memory against the container's own limits, and says when it has none", async () => {
    const { rerender } = render(DockerDetailModal, { props: { ...props(), tab: "resources", history: hist, seq: 1, facts: facts() } });
    const res = screen.getByTestId("docker-detail-resources");
    expect(res).toHaveTextContent("30.0%");
    expect(res).toHaveTextContent("limit 0.5 cores");
    expect(res).toHaveTextContent("of 1.0 GiB");
    for (const id of ["docker-res-cpu", "docker-res-mem", "docker-res-net", "docker-res-disk"]) expect(screen.getByTestId(id)).toBeInTheDocument();
    await rerender({ facts: facts({ cpuCores: null, memBytes: null }) });
    expect(screen.getByTestId("docker-detail-resources")).toHaveTextContent("no limit");
  });

  it("says a stopped container has no readings", () => {
    render(DockerDetailModal, { props: { ...props({ container: container({ state: "exited", status: "Exited (0) 1 hour ago" }) }), tab: "resources" } });
    expect(screen.getByTestId("docker-res-down")).toBeInTheDocument();
  });

  it("lists what happened to it lately in the Overview, a crash in red", async () => {
    const events: ContainerEvent[] = [
      { at: Date.parse("2026-11-07T10:00:05Z"), kind: "die", health: "", id: "abc123456789", name: "web", exitCode: 1, signal: "" },
      { at: Date.parse("2026-11-07T10:00:00Z"), kind: "start", health: "", id: "abc123456789", name: "web", exitCode: null, signal: "" },
    ];
    render(DockerDetailModal, {
      props: { ...props({ runQuery: vi.fn().mockResolvedValue({ stdout: INSPECT_FIXTURE, stderr: "", exitCode: 0 }) }), tab: "overview", events },
    });
    await vi.advanceTimersByTimeAsync(0);
    const list = screen.getByTestId("docker-detail-events");
    expect(list).toHaveTextContent("Events in 10 min");
    expect(list).toHaveTextContent("die · exit 1");
    expect(within(list).getByText("die · exit 1").className).toContain("text-bad");
  });

  it("still lists them when the container's details could not be read — they come from the panel, not from inspect", async () => {
    const events: ContainerEvent[] = [{ at: Date.parse("2026-11-07T10:00:05Z"), kind: "oom", health: "", id: "abc123456789", name: "web", exitCode: null, signal: "" }];
    render(DockerDetailModal, {
      props: { ...props({ runQuery: vi.fn().mockResolvedValue({ stdout: "Error", stderr: "", exitCode: 1 }) }), tab: "overview", events },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-detail-unread")).toBeInTheDocument();
    expect(screen.getByTestId("docker-detail-events")).toHaveTextContent("oom");
  });
});
