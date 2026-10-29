import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import adapter from "@sveltejs/adapter-static";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    // SvelteKit 3 reads its config only from here (svelte.config.js is gone).
    // Tauri has no Node.js server for SSR, so adapter-static with an index.html
    // fallback puts the site in SPA mode:
    // https://svelte.dev/docs/kit/single-page-apps, https://v2.tauri.app/start/frontend/sveltekit/
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
      // SvelteKit 3 polls `_app/version.json` hourly for a new deployment. The
      // bundle is embedded in the binary and cannot change while it runs, so the
      // timer stays off, as it was by default in SvelteKit 2 (ADR 0046).
      version: { pollInterval: 0 },
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
