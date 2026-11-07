import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import K8sWorkloadDetail from "./K8sWorkloadDetail.svelte";
import { parseJobs, parseWorkloadDetail, type K8sWorkload } from "./k8s";

// Stage 4 (ADR 0054): a workload's details. The objects are the stand's
// (e2e/k8s/stand.yaml) as Docker Desktop's k8s 1.31.1 answered, trimmed.

const rolloutObj = {
  kind: "Deployment",
  metadata: { name: "rollout", namespace: "vterm-stand", uid: "uid-rollout", annotations: { "deployment.kubernetes.io/revision": "2" } },
  spec: {
    replicas: 2,
    strategy: { rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" }, type: "RollingUpdate" },
    selector: { matchLabels: { app: "rollout" } },
    progressDeadlineSeconds: 30,
    template: { spec: { containers: [{ name: "app", image: "busybox:vterm-missing-tag" }] } },
  },
  status: {
    replicas: 3,
    updatedReplicas: 1,
    readyReplicas: 2,
    availableReplicas: 2,
    unavailableReplicas: 1,
    conditions: [
      { type: "Available", status: "True", reason: "MinimumReplicasAvailable", message: "Deployment has minimum availability." },
      { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "rollout-5d9c" has timed out progressing.' },
    ],
  },
};
const rollout: K8sWorkload = {
  kind: "Deployment",
  name: "rollout",
  namespace: "vterm-stand",
  ready: "2/2",
  replicas: 2,
  schedule: "",
  suspended: false,
  age: "1h",
  scalable: true,
  uid: "uid-rollout",
};
const rs = (name: string, rev: string, image: string, replicas: number, ready: number) => ({
  metadata: { name, namespace: "vterm-stand", annotations: { "deployment.kubernetes.io/revision": rev }, ownerReferences: [{ kind: "Deployment", name: "rollout", uid: "uid-rollout", controller: true }] },
  spec: { replicas, template: { spec: { containers: [{ name: "app", image }] } } },
  status: { readyReplicas: ready },
});
const pod = (name: string, rsName: string, phase: string, state: Record<string, unknown>, ready: boolean) => ({
  metadata: { name, namespace: "vterm-stand", ownerReferences: [{ kind: "ReplicaSet", name: rsName, controller: true }] },
  spec: { containers: [{ name: "app" }] },
  status: { phase, containerStatuses: [{ name: "app", ready, state }] },
});
const PODS = JSON.stringify({
  items: [
    pod("rollout-7f9c-a", "rollout-7f9c", "Running", { running: {} }, true),
    pod("rollout-5d9c-b", "rollout-5d9c", "Pending", { waiting: { reason: "ImagePullBackOff" } }, false),
  ],
});
const RS = JSON.stringify({ items: [rs("rollout-7f9c", "1", "busybox:1.37", 2, 2), rs("rollout-5d9c", "2", "busybox:vterm-missing-tag", 1, 0)] });

function answer(args: string[]) {
  const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
  if (args[1] === "pods") return ok(PODS);
  if (args[1] === "replicasets") return ok(RS);
  return ok(`text of ${args.join(" ")}`);
}

function props(over: Record<string, unknown> = {}) {
  return {
    active: true,
    workload: rollout,
    detail: parseWorkloadDetail(rolloutObj),
    runQuery: vi.fn(async (args: string[]) => answer(args)),
    onOpenPod: vi.fn(),
    ...over,
  };
}

describe("K8sWorkloadDetail (stage 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says what a Deployment is told and has, and why its rollout is stuck", () => {
    render(K8sWorkloadDetail, { props: props() });
    expect(screen.getByTestId("k8s-work-replicas")).toHaveTextContent("2 of 2 ready · 1 updated · 2 available · 1 unavailable");
    const overview = screen.getByTestId("k8s-work-overview");
    expect(overview).toHaveTextContent("RollingUpdate · maxSurge 25% · maxUnavailable 25%");
    expect(overview).toHaveTextContent("app=rollout");
    expect(overview).toHaveTextContent("busybox:vterm-missing-tag");
    const [, progressing] = screen.getAllByTestId("k8s-work-condition");
    expect(progressing).toHaveTextContent("ProgressDeadlineExceeded");
    expect(progressing).toHaveTextContent('ReplicaSet "rollout-5d9c" has timed out progressing.');
  });

  it("asks its pods and ReplicaSets by its selector, shows the revisions and opens a pod", async () => {
    const p = props();
    render(K8sWorkloadDetail, { props: p });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.runQuery).toHaveBeenCalledWith(["get", "pods", "--selector=app=rollout", "-o", "json"], "vterm-stand", 20);
    expect(p.runQuery).toHaveBeenCalledWith(["get", "replicasets", "--selector=app=rollout", "-o", "json"], "vterm-stand", 20);
    const [rev2, rev1] = screen.getAllByTestId("k8s-work-revision");
    expect(rev2).toHaveTextContent("#2");
    expect(rev2).toHaveTextContent("current");
    expect(rev2).toHaveTextContent("0/1");
    expect(rev1).toHaveTextContent("#1");
    expect(rev1).toHaveTextContent("busybox:1.37");
    const pods = screen.getAllByTestId("k8s-work-pod");
    expect(pods.map((x) => x.textContent)).toEqual([expect.stringContaining("rollout-7f9c-a"), expect.stringContaining("ImagePullBackOff")]);
    await fireEvent.click(pods[1]);
    expect(p.onOpenPod).toHaveBeenCalledWith(expect.objectContaining({ name: "rollout-5d9c-b" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.runQuery.mock.calls.filter((c) => c[0][1] === "pods")).toHaveLength(2);
  });

  it("asks nothing it owns while another view is on screen, and reads that view's text", async () => {
    const p = props({ tab: "describe" });
    render(K8sWorkloadDetail, { props: p });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.runQuery.mock.calls.map((c) => c[0].join(" "))).toEqual(["describe deployment rollout"]);
    expect(screen.getByTestId("k8s-work-text")).toHaveTextContent("text of describe deployment rollout");
  });

  it("says when its pods could not be read — that is not «no pods»", async () => {
    const p = props({ runQuery: vi.fn(async () => ({ stdout: "", stderr: "Error from server (Forbidden): pods is forbidden", exitCode: 1 })) });
    render(K8sWorkloadDetail, { props: p });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-work-pods")).toHaveTextContent("Could not be read: Error from server (Forbidden): pods is forbidden");
  });

  it("shows a CronJob's runs with how each ended, and that it never succeeded", () => {
    const cron = {
      kind: "CronJob",
      metadata: { name: "report", namespace: "vterm-stand", uid: "uid-report" },
      spec: { schedule: "*/1 * * * *", concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 2, jobTemplate: { spec: { template: { spec: { containers: [{ image: "busybox:1.37" }] } } } } },
      status: { lastScheduleTime: "2026-11-07T14:03:00Z" },
    };
    const jobs = parseJobs(
      JSON.stringify({
        items: [
          {
            metadata: { name: "report-29901003", namespace: "vterm-stand", ownerReferences: [{ kind: "CronJob", name: "report", uid: "uid-report", controller: true }] },
            status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" }] },
          },
        ],
      }),
    );
    const runQuery = vi.fn(async (args: string[]) => answer(args));
    render(K8sWorkloadDetail, {
      props: props({ workload: { ...rollout, kind: "CronJob", name: "report", scalable: false }, detail: parseWorkloadDetail(cron), jobs, runQuery }),
    });
    const job = screen.getByTestId("k8s-work-job");
    expect(job).toHaveTextContent("report-29901003");
    expect(job).toHaveTextContent("Failed");
    expect(job).toHaveTextContent("BackoffLimitExceeded");
    expect(job).toHaveTextContent("Job has reached the specified backoff limit");
    expect(screen.getByTestId("k8s-work-last-success")).toHaveTextContent("never");
    expect(screen.getByTestId("k8s-work-overview")).toHaveTextContent("1 successful, 2 failed");
    // A CronJob has no selector of its own: nothing is asked for it.
    expect(runQuery).not.toHaveBeenCalled();
  });
});
