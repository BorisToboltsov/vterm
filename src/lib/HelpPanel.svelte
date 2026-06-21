<script lang="ts">
  import { onMount } from "svelte";
  import { getName, getVersion, getTauriVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";

  let {
    open = $bindable(false),
    tab = $bindable<"help" | "about">("help"),
  }: { open?: boolean; tab?: "help" | "about" } = $props();

  let appName = $state("vterm");
  let version = $state("");
  let tauriVersion = $state("");

  onMount(async () => {
    try {
      appName = await getName();
      version = await getVersion();
      tauriVersion = await getTauriVersion();
    } catch {
      /* not running under Tauri (e.g. plain `pnpm dev`) */
    }
  });

  function ext(url: string) {
    openUrl(url).catch(() => {});
  }

  const hotkeys: [string, string][] = [
    ["Command palette", "⌘K  /  Ctrl+K"],
    ["Copy selection", "⌘C  /  Ctrl+Shift+C"],
    ["Paste", "⌘V  /  Ctrl+Shift+V"],
    ["Interrupt (SIGINT)", "Ctrl+C"],
    ["Connect to selected server", "Double-click server"],
    ["Reorder tabs", "Drag a tab"],
  ];
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label="Close help"
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative flex max-h-[80vh] w-[30rem] flex-col rounded-lg border border-edge bg-panel-alt"
    >
      <div class="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button
          class="text-sm font-semibold {tab === 'help'
            ? 'text-accent'
            : 'text-muted hover:text-white'}"
          onclick={() => (tab = "help")}>Help</button
        >
        <button
          class="text-sm font-semibold {tab === 'about'
            ? 'text-accent'
            : 'text-muted hover:text-white'}"
          onclick={() => (tab = "about")}>About</button
        >
        <button
          class="ml-auto rounded px-2 text-muted hover:text-white"
          aria-label="Close"
          onclick={() => (open = false)}>×</button
        >
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
        {#if tab === "help"}
          <p class="mb-3 text-xs text-muted">
            vterm — SSH-терминал и SFTP-клиент. Выберите сервер слева и нажмите
            <span class="text-green-500">Connect</span> (или дважды кликните по
            серверу). Несколько подключений живут в отдельных вкладках. SFTP —
            в правой панели (разворачивается и подключается кнопкой Connect внутри
            неё).
          </p>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Hotkeys</h3>
          <table class="w-full text-xs">
            <tbody>
              {#each hotkeys as [action, keys] (action)}
                <tr class="border-b border-edge/50">
                  <td class="py-1 text-muted">{action}</td>
                  <td class="py-1 text-right font-mono text-white">{keys}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="space-y-2 text-xs">
            <div class="text-lg font-semibold text-accent">{appName}</div>
            <div class="text-muted">
              Version <span class="text-white">{version || "—"}</span>
              {#if tauriVersion}
                · Tauri <span class="text-white">{tauriVersion}</span>
              {/if}
            </div>
            <p class="text-muted">
              Кроссплатформенный SSH-терминал и SFTP-клиент с графическим
              интерфейсом.
            </p>
            <p class="text-muted">
              Автор: <span class="text-white">Тобольцов Борис Олегович</span>
            </p>
            <p class="text-muted">Лицензия: MIT</p>
            <h3 class="pt-2 text-xs uppercase tracking-wider text-muted">
              Технологии
            </h3>
            <ul class="space-y-1">
              <li>
                <button class="text-accent hover:underline" onclick={() => ext("https://tauri.app")}
                  >Tauri 2</button
                > — нативное окно + Rust-бэкенд
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://github.com/Eugeny/russh")}>russh</button
                > — SSH-клиент на Rust
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://xtermjs.org")}>xterm.js</button
                > — веб-терминал
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://svelte.dev")}>SvelteKit</button
                > — UI
              </li>
            </ul>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
