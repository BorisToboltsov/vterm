import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { mdLinks } from "./mdlinks";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

function mount(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  mdLinks(el);
  return el;
}

function clickFirstAnchor(el: HTMLElement) {
  const anchor = el.querySelector("a") as HTMLAnchorElement;
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  anchor.dispatchEvent(ev);
  return ev;
}

describe("mdLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("scrolls to the matching heading for an in-page anchor, never navigating", () => {
    const el = mount('<a href="#git" data-md-link>Git</a><h3 id="git">Git</h3>');
    const heading = el.querySelector("#git") as HTMLElement;
    heading.scrollIntoView = vi.fn();
    const ev = clickFirstAnchor(el);
    expect(ev.defaultPrevented).toBe(true); // WebView must not navigate
    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("stays inert (no throw) for a fragment with no matching heading", () => {
    const el = mount('<a href="#missing" data-md-link>x</a>');
    const ev = clickFirstAnchor(el);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens http(s) links through the system opener", () => {
    const el = mount('<a href="https://vcore.su" data-md-link>site</a>');
    clickFirstAnchor(el);
    expect(openUrl).toHaveBeenCalledWith("https://vcore.su");
  });

  it("refuses a non-http scheme: no open, no navigation", () => {
    // eslint-disable-next-line no-script-url
    const el = mount('<a href="javascript:alert(1)" data-md-link>x</a>');
    const ev = clickFirstAnchor(el);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
