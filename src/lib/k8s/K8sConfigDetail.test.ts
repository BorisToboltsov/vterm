import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import K8sConfigDetail from "./K8sConfigDetail.svelte";
import { parseConfigMaps, parseSecrets } from "./k8s";

// v1.36, ADR 0061: a ConfigMap's values, masked where they look like a secret;
// a Secret's keys, and no value — the app never reads one.

const map = parseConfigMaps(
  JSON.stringify({
    items: [
      {
        metadata: { namespace: "web", name: "app", creationTimestamp: "2026-11-08T10:00:00Z" },
        data: { LOG_LEVEL: "debug", DB_PASSWORD: "hunter2" },
        binaryData: { "logo.png": "iVBORw0KGgo=" },
      },
    ],
  }),
)[0];
const secret = parseSecrets("web\tcreds\tOpaque\t2026-11-08T10:00:00Z\tpassword user \n")[0];

describe("K8sConfigDetail", () => {
  it("shows a ConfigMap's values and masks the one that looks like a secret until asked", async () => {
    render(K8sConfigDetail, { props: { config: map } });
    const [password, level, logo] = screen.getAllByTestId("k8s-config-entry");
    expect(password).toHaveTextContent("DB_PASSWORD");
    expect(password).not.toHaveTextContent("hunter2");
    expect(level).toHaveTextContent("debug");
    expect(logo).toHaveTextContent("Binary data");
    await fireEvent.click(screen.getByRole("button", { name: "Show the value" }));
    expect(password).toHaveTextContent("hunter2");
    await fireEvent.click(screen.getByRole("button", { name: "Hide the value" }));
    expect(password).not.toHaveTextContent("hunter2");
  });

  it("another ConfigMap starts masked again", async () => {
    const { rerender } = render(K8sConfigDetail, { props: { config: map } });
    await fireEvent.click(screen.getByRole("button", { name: "Show the value" }));
    await rerender({ config: { ...map, name: "other" } });
    expect(screen.getByTestId("k8s-config-masked")).toBeInTheDocument();
  });

  it("shows a Secret's type and keys, says why there is no value, and offers none to show", () => {
    render(K8sConfigDetail, { props: { config: secret } });
    expect(screen.getByTestId("k8s-config-detail")).toHaveTextContent("Opaque");
    expect(screen.getAllByTestId("k8s-config-entry").map((e) => e.textContent?.trim())).toEqual(["password", "user"]);
    expect(screen.getByTestId("k8s-secret-note")).toHaveTextContent("never reads a Secret's values");
    expect(screen.queryByRole("button", { name: "Show the value" })).toBeNull();
    expect(screen.queryByTestId("k8s-config-copy")).toBeNull();
  });
});
