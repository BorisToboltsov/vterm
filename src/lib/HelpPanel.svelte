<script lang="ts">
  import { onMount } from "svelte";
  import { getName, getVersion, getTauriVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { renderMarkdown } from "./markdown";
  import guide from "../../docs/GUIDE.md?raw";
  import Icon from "./Icon.svelte";
  import AppLogo from "./AppLogo.svelte";
  import { t, type MessageKey } from "./i18n";

  let {
    open = $bindable(false),
    tab = $bindable<"help" | "about" | "manual">("help"),
  }: { open?: boolean; tab?: "help" | "about" | "manual" } = $props();

  let appName = $state("vterm");
  let version = $state("");
  let tauriVersion = $state("");

  // The bundled user guide (docs/GUIDE.md), rendered once (static content, no user input).
  const manualHtml = renderMarkdown(guide);

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

  // Links inside the rendered manual must never navigate the WebView: open
  // http(s) targets in the system browser via the opener, ignore the rest
  // (relative repo links). Mirrors the offline-autonomy invariant.
  function onManualClick(e: Event) {
    const a = (e.target as HTMLElement | null)?.closest?.("a[data-md-link]") as
      | HTMLAnchorElement
      | null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) ext(href);
  }

  // Delegate link clicks via addEventListener (not an `onclick` on the
  // non-interactive container, which would trip a11y lint).
  function manualLinks(node: HTMLElement) {
    node.addEventListener("click", onManualClick);
    return {
      destroy() {
        node.removeEventListener("click", onManualClick);
      },
    };
  }

  // [label message-key, key combo, optional combo message-key]. Key combos that
  // are pure symbols (⌘K …) stay literal; descriptive ones are translated.
  // Feature names shown as chips above the hotkeys (SSH/SFTP first, then by theme).
  const features: MessageKey[] = [
    "help.featSsh",
    "help.featSftp",
    "help.featEditor",
    "help.featStructuredLogs",
    "help.featMonitoring",
    "help.featRecording",
    "help.featAi",
  ];

  const hotkeys: [MessageKey, string, MessageKey?][] = [
    ["help.hkCommandPalette", "⌘K  /  Ctrl+K"],
    ["help.hkNewTab", "⌘T  /  Ctrl+T"],
    ["help.hkSearch", "⌘F  /  Ctrl+Shift+F"],
    ["help.hkHistory", "Ctrl+R"],
    ["help.hkCopySelection", "⌘C  /  Ctrl+Shift+C"],
    ["help.hkPaste", "⌘V  /  Ctrl+Shift+V"],
    ["help.hkInterrupt", "Ctrl+C"],
    ["help.hkConnect", "", "help.hkConnectKeys"],
    ["help.hkReorder", "", "help.hkReorderKeys"],
  ];
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label={t("help.close")}
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative flex max-h-[80vh] w-[90vw] flex-col rounded-lg border border-edge bg-panel-alt {tab ===
      'manual'
        ? 'sm:w-[46rem]'
        : 'sm:w-[30rem]'}"
    >
      <div class="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button
          class="text-sm font-semibold {tab === 'help'
            ? 'text-accent'
            : 'text-muted hover:text-white'}"
          onclick={() => (tab = "help")}>{t("help.tabHelp")}</button
        >
        <button
          class="text-sm font-semibold {tab === 'manual'
            ? 'text-accent'
            : 'text-muted hover:text-white'}"
          onclick={() => (tab = "manual")}>{t("help.tabManual")}</button
        >
        <button
          class="text-sm font-semibold {tab === 'about'
            ? 'text-accent'
            : 'text-muted hover:text-white'}"
          onclick={() => (tab = "about")}>{t("help.tabAbout")}</button
        >
        <button
          class="ml-auto rounded p-0.5 text-muted hover:text-danger"
          aria-label={t("common.close")}
          onclick={() => (open = false)}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
        {#if tab === "help"}
          <!-- App logo (same mark as the OS icon): two cascading terminal windows
               with a ›_ prompt. Reflects the active theme's backdrop in-app. Sits
               right before the intro slogan. -->
          <div class="mb-3 flex items-center gap-3">
            <AppLogo size={40} label={appName} />
            <p class="min-w-0 text-xs text-muted">{t("help.intro")}</p>
          </div>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("help.features")}</h3>
          <div class="mb-3 flex flex-wrap gap-1.5">
            {#each features as f (f)}
              <span
                class="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-meta text-accent"
                >{t(f)}</span
              >
            {/each}
          </div>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("help.hotkeys")}</h3>
          <table class="w-full text-xs">
            <tbody>
              {#each hotkeys as [labelKey, keys, keysLabel] (labelKey)}
                <tr class="border-b border-edge/50">
                  <td class="py-1 text-muted">{t(labelKey)}</td>
                  <td class="py-1 text-right font-mono text-white"
                    >{keysLabel ? t(keysLabel) : keys}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === "manual"}
          <!-- Bundled README, rendered to HTML. Links go through the opener. -->
          <div class="manual text-xs leading-relaxed text-text" use:manualLinks>
            {@html manualHtml}
          </div>
        {:else}
          <div class="space-y-2 text-xs">
            <div class="text-lg font-semibold text-accent">{appName}</div>
            <div class="text-muted">
              {t("help.version")} <span class="text-white">{version || "—"}</span>
              {#if tauriVersion}
                · Tauri <span class="text-white">{tauriVersion}</span>
              {/if}
            </div>
            <p class="text-muted">
              {t("help.author")}: <span class="text-white">Тобольцов Борис Олегович</span>
            </p>
            <p class="text-muted">
              {t("help.email")}: <span class="select-text text-white">bt@vcore.su</span>
            </p>
            <p class="text-muted">
              Telegram: <button
                class="text-accent hover:underline"
                onclick={() => ext("https://t.me/BorisToboltsov")}>@BorisToboltsov</button
              >
            </p>
            <p class="text-muted">{t("help.license")}: MIT</p>
            <h3 class="pt-2 text-xs uppercase tracking-wider text-muted">
              {t("help.technologies")}
            </h3>
            <ul class="space-y-1">
              <li>
                <button class="text-accent hover:underline" onclick={() => ext("https://tauri.app")}
                  >Tauri 2</button
                > — {t("help.techTauri")}
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://github.com/Eugeny/russh")}>russh</button
                > — {t("help.techRussh")}
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://xtermjs.org")}>xterm.js</button
                > — {t("help.techXterm")}
              </li>
              <li>
                <button
                  class="text-accent hover:underline"
                  onclick={() => ext("https://svelte.dev")}>SvelteKit</button
                > — {t("help.techSvelte")}
              </li>
            </ul>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!--
  Styling for the {@html}-rendered manual. Svelte's scoped styles don't reach
  injected HTML, so descendants of `.manual` are targeted with `:global(...)`.
  Colors use the theme tokens (var(--color-*)) so the manual follows the UI theme.
-->
<style>
  .manual :global(h1),
  .manual :global(h2),
  .manual :global(h3),
  .manual :global(h4) {
    font-weight: 600;
    color: var(--color-text);
    margin: 1.1em 0 0.5em;
    line-height: 1.3;
  }
  .manual :global(h1) {
    font-size: 1.35em;
  }
  .manual :global(h2) {
    font-size: 1.15em;
    border-bottom: 1px solid var(--color-edge);
    padding-bottom: 0.25em;
  }
  .manual :global(h3) {
    font-size: 1.05em;
  }
  .manual :global(h1:first-child) {
    margin-top: 0;
  }
  .manual :global(p) {
    margin: 0.6em 0;
  }
  .manual :global(ul) {
    margin: 0.5em 0;
    padding-left: 1.2em;
    list-style: disc;
  }
  .manual :global(li) {
    margin: 0.2em 0;
  }
  .manual :global(a) {
    color: var(--color-accent);
    cursor: pointer;
  }
  .manual :global(a:hover) {
    text-decoration: underline;
  }
  .manual :global(strong) {
    color: var(--color-text);
    font-weight: 600;
  }
  .manual :global(code) {
    font-family: ui-monospace, monospace;
    background: var(--color-panel);
    border: 1px solid var(--color-edge);
    border-radius: 4px;
    padding: 0 0.3em;
    font-size: 0.92em;
  }
  .manual :global(pre) {
    background: var(--color-panel);
    border: 1px solid var(--color-edge);
    border-radius: 6px;
    padding: 0.75em;
    overflow-x: auto;
    margin: 0.7em 0;
  }
  .manual :global(pre code) {
    background: none;
    border: none;
    padding: 0;
  }
  .manual :global(blockquote) {
    border-left: 3px solid var(--color-edge);
    padding: 0.1em 0.8em;
    margin: 0.7em 0;
    color: var(--color-muted);
  }
  .manual :global(hr) {
    border: none;
    border-top: 1px solid var(--color-edge);
    margin: 1em 0;
  }
  .manual :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.7em 0;
    display: block;
    overflow-x: auto;
  }
  .manual :global(th),
  .manual :global(td) {
    border: 1px solid var(--color-edge);
    padding: 0.3em 0.5em;
    text-align: left;
  }
  .manual :global(th) {
    background: var(--color-panel);
    color: var(--color-text);
  }
</style>
