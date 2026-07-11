// The host OS the app runs on, resolved once from the Rust backend (`host_os`
// command → `std::env::consts::OS`) and cached. Kept as a runes store so the UI
// can gate OS-specific settings (the Windows local-shell picker) reactively,
// without pulling a runtime OS plugin into the offline WebView.

import { hostOs } from "../api";

class HostEnv {
  /** "windows" | "macos" | "linux" | … — empty until the first resolve lands. */
  os = $state("");
  #promise: Promise<string> | null = null;

  /**
   * Resolve the host OS (cached; the backend is queried at most once) and update
   * the reactive `os`. Awaitable for a value at spawn time, or fired once from a
   * component so `os`/`isWindows` become reactively available.
   */
  resolve(): Promise<string> {
    if (!this.#promise) {
      this.#promise = hostOs().catch(() => "");
      void this.#promise.then((v) => {
        this.os = v;
      });
    }
    return this.#promise;
  }

  get isWindows(): boolean {
    return this.os === "windows";
  }
}

export const hostEnv = new HostEnv();
