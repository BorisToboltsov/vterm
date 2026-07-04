// Global test setup: jest-dom custom matchers (toBeInTheDocument, etc.) and a
// deterministic localStorage.
//
// Node 25 ships a built-in global `localStorage` stub that lacks the standard
// Storage methods and shadows jsdom's implementation, so we install a small
// in-memory Storage and reset it between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

class MemoryStorage {
  #map = new Map<string, string>();
  get length() {
    return this.#map.size;
  }
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  clear(): void {
    this.#map.clear();
  }
  key(i: number): string | null {
    return Array.from(this.#map.keys())[i] ?? null;
  }
}

// jsdom doesn't implement scrollIntoView; provide a no-op so deep-link scrolling
// (SettingsPanel) doesn't emit "Not implemented" noise in tests.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom doesn't implement ResizeObserver, which SettingsPanel uses to re-scroll a
// deep-linked section after its async content grows. Provide a controllable mock:
// tests can grab the latest instance and fire its callback to simulate a resize.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverMock {
    static instances: ResizeObserverMock[] = [];
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      ResizeObserverMock.instances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

// jsdom lacks the Web Animations API that Svelte 5 transitions (slide/fade) use.
// Provide a no-op `Element.prototype.animate` so transitions don't crash in tests
// (the element is still inserted/removed; only the visual tween is skipped).
if (typeof Element !== "undefined" && !Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    return {
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      finished: Promise.resolve(),
      onfinish: null,
      oncancel: null,
      currentTime: 0,
      startTime: 0,
      playState: "finished",
    } as unknown as Animation;
  };
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());
