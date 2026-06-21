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

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());
