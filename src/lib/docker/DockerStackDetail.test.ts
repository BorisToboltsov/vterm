import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DockerStackDetail from "./DockerStackDetail.svelte";
import type { DockerStack } from "./dockerstack";

const OWN: DockerStack = { project: "life-e2e", workdir: "/srv/deploy", files: ["/srv/deploy/compose.yaml", "/srv/deploy/compose.build.yaml"], envFile: "/srv/deploy/e2e.env" };
const PLAIN: DockerStack = { project: "web", workdir: "/srv/web", files: ["/srv/web/compose.yaml"], envFile: "" };
const PS = [
  '{"Service":"backend","ID":"43d5","Name":"x-backend-1","State":"running","Health":"unhealthy","ExitCode":0}',
  '{"Service":"db","ID":"ec54","Name":"x-db-1","State":"exited","Health":"","ExitCode":0}',
].join("\n");
const CONFIG = "services:\n  backend:\n    environment:\n      DATABASE_URL: postgres://app:hunter2@db/app\n      JWT_SECRET: s3cr3t\n";

function query(over: Partial<Record<string, { stdout: string; exitCode: number; stderr?: string }>> = {}) {
  return vi.fn(async (args: string[]) => {
    const key = args.includes("ps") ? "ps" : args.includes("--services") ? "services" : args.includes("config") ? "config" : args.includes("logs") ? "logs" : "other";
    const fallback: Record<string, { stdout: string; exitCode: number; stderr?: string }> = {
      ps: { stdout: PS, exitCode: 0 },
      services: { stdout: "db\nbackend\nworker\n", exitCode: 0 },
      config: { stdout: CONFIG, exitCode: 0 },
      logs: { stdout: "backend-1  | GET /healthz 503", exitCode: 0 },
      other: { stdout: "", exitCode: 0 },
    };
    const r = over[key] ?? fallback[key];
    return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode };
  });
}
const props = (over: Record<string, unknown> = {}) => ({ stack: PLAIN, run: vi.fn().mockResolvedValue(true), runQuery: query(), onopen: vi.fn(), ...over });

describe("DockerStackDetail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists the declared services, the never created among them, each with its state", async () => {
    render(DockerStackDetail, { props: props() });
    await vi.advanceTimersByTimeAsync(0);
    const rows = screen.getAllByTestId("docker-stack-service");
    expect(rows.map((r) => r.querySelector("span.font-medium")?.textContent)).toEqual(["db", "backend", "worker"]);
    expect(rows[1]).toHaveTextContent("unhealthy");
    expect(rows[2]).toHaveTextContent("not created");
  });

  it("acts on one service by the project's name, and brings a never created one up from its directory", async () => {
    const p = props();
    render(DockerStackDetail, { props: p });
    await vi.advanceTimersByTimeAsync(0);
    const [db, backend, worker] = screen.getAllByTestId("docker-stack-service");
    await fireEvent.click(within(backend).getByTestId("docker-stack-restart"));
    expect(p.run.mock.calls.at(-1)?.[0]).toEqual(["docker", "compose", "-p", "web", "restart", "backend"]);
    await fireEvent.click(within(db).getByTestId("docker-stack-start"));
    expect(p.run.mock.calls.at(-1)?.[0]).toEqual(["docker", "compose", "-p", "web", "start", "db"]);
    await fireEvent.click(within(worker).getByTestId("docker-stack-up"));
    expect(p.run.mock.calls.at(-1)?.[0]).toEqual(["docker", "compose", "--project-directory", "/srv/web", "-p", "web", "up", "-d", "worker"]);
  });

  it("offers the hand-run command where the stack came up from its own files", async () => {
    render(DockerStackDetail, { props: props({ stack: OWN }) });
    await vi.advanceTimersByTimeAsync(0);
    const worker = screen.getAllByTestId("docker-stack-service")[2];
    expect(within(worker).queryByTestId("docker-stack-up")).toBeNull();
    expect(within(worker).getByTestId("docker-stack-up-copy")).toBeInTheDocument();
  });

  it("says when the files could not be read — and lists what has containers", async () => {
    render(DockerStackDetail, { props: props({ runQuery: query({ services: { stdout: "", stderr: "required variable X is missing", exitCode: 1 } }) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getAllByTestId("docker-stack-service")).toHaveLength(2);
    expect(screen.getByTestId("docker-stack-undeclared-unknown")).toBeInTheDocument();
  });

  it("reads one service's log from its row", async () => {
    const p = props();
    render(DockerStackDetail, { props: p });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(within(screen.getAllByTestId("docker-stack-service")[1]).getByTestId("docker-stack-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.runQuery.mock.calls.at(-1)?.[0]).toEqual(["docker", "compose", "-p", "web", "logs", "--tail", "200", "--timestamps", "--no-color", "backend"]);
    expect(screen.getByTestId("docker-stack-text")).toHaveTextContent("GET /healthz 503");
  });

  it("shows the configuration with what looks like a secret masked until asked", async () => {
    render(DockerStackDetail, { props: props() });
    await fireEvent.click(screen.getByTestId("docker-stack-tab-config"));
    await vi.advanceTimersByTimeAsync(0);
    const cfg = screen.getByTestId("docker-stack-config");
    expect(cfg).not.toHaveTextContent("hunter2");
    expect(cfg).not.toHaveTextContent("s3cr3t");
    expect(cfg).toHaveTextContent("‹redacted›");
    await fireEvent.click(screen.getByTestId("docker-stack-config-reveal"));
    expect(cfg).toHaveTextContent("s3cr3t");
  });

  it("gives compose's own words when the configuration cannot be rendered", async () => {
    render(DockerStackDetail, { props: props({ runQuery: query({ config: { stdout: "", stderr: "required variable POSTGRES_PASSWORD is missing a value", exitCode: 15 } }) }) });
    await fireEvent.click(screen.getByTestId("docker-stack-tab-config"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-stack-config")).toHaveTextContent("POSTGRES_PASSWORD is missing");
  });
});
