import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PollFailStrip from "./PollFailStrip.svelte";

describe("PollFailStrip", () => {
  it("is not there while the reads succeed", () => {
    render(PollFailStrip, { props: { failure: null, onretry: () => {} } });
    expect(screen.queryByTestId("poll-fail")).toBeNull();
  });

  it("says since when nothing newer came, the error and how many times, and reads again on request", async () => {
    const onretry = vi.fn();
    render(PollFailStrip, {
      props: { failure: { text: "exec channel failed: the server did not answer in 10 s", since: Date.now(), count: 4 }, onretry },
    });
    const strip = screen.getByTestId("poll-fail");
    expect(strip).toHaveTextContent("Not refreshed since");
    expect(strip).toHaveTextContent("did not answer in 10 s");
    expect(screen.getByTestId("poll-fail-count")).toHaveTextContent("×4");
    await userEvent.click(screen.getByTestId("poll-fail-retry"));
    expect(onretry).toHaveBeenCalledOnce();
  });
});
