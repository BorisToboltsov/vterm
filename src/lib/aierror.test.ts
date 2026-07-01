import { beforeEach, describe, it, expect } from "vitest";
import { describeAiError } from "./aierror";
import { settings } from "./settings.svelte";

beforeEach(() => {
  settings.language = "en";
});

describe("describeAiError", () => {
  it("gives a friendly auth hint (no raw marker)", () => {
    const msg = describeAiError("auth-rejected: wrong password or key not accepted");
    expect(msg).not.toContain("auth-rejected");
    expect(msg).toMatch(/API key/i);
  });

  it("gives a friendly unreachable hint", () => {
    const msg = describeAiError("ai-unreachable: error sending request");
    expect(msg).not.toContain("ai-unreachable");
    expect(msg).toMatch(/reach|base URL/i);
  });

  it("explains a billing / credit failure", () => {
    const msg = describeAiError("ai endpoint 400: Your credit balance is too low to access the API");
    expect(msg).not.toContain("credit balance"); // mapped to a localized hint
    expect(msg).toMatch(/credit|quota|billing|balance/i);
  });

  it("explains a rate limit", () => {
    expect(describeAiError("ai endpoint 429: rate limit")).toMatch(/rate limit|try again/i);
  });

  it("passes the raw detail through for other errors", () => {
    expect(describeAiError("ai endpoint 500: boom")).toContain("500");
  });

  it("falls back to a generic message when empty", () => {
    expect(describeAiError("")).toBeTruthy();
  });
});
