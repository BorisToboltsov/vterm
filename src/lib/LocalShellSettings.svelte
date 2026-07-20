<script lang="ts">
  // Local-terminal shell picker (part of the Terminal settings section). On
  // Windows the user chooses cmd / Windows PowerShell / pwsh (PowerShell 7, grayed
  // out with a hint when not installed) / a custom path; on macOS/Linux only a
  // custom `$SHELL` override is offered. The host OS comes from the backend
  // (`hostEnv`, no runtime OS plugin); shell resolution stays pure (`localshell.ts`).
  import { settings } from "./settings.svelte";
  import { hostEnv } from "./stores/hostenv.svelte";
  import { shellExists } from "./api";
  import { t } from "./i18n";
  import InfoHint from "./InfoHint.svelte";
  import { slide } from "svelte/transition";
  import { motion, MOTION_BASE } from "./motion";

  hostEnv.resolve();

  let pwshAvailable = $state(true);
  let customValid = $state(true);

  // Detect PowerShell 7 once we know we're on Windows, so the pwsh option can warn
  // when it isn't installed rather than spawning a tab that immediately exits.
  $effect(() => {
    if (hostEnv.isWindows) {
      void shellExists("pwsh.exe").then((v) => (pwshAvailable = v));
    }
  });

  // Validate the custom path (empty = OS default, always valid).
  $effect(() => {
    const p = settings.localShellPath.trim();
    if (!p) {
      customValid = true;
      return;
    }
    void shellExists(p).then((v) => (customValid = v));
  });

  // The custom-path field shows on every non-Windows host, and on Windows only
  // when the "custom" preset is selected.
  const showCustomPath = $derived(!hostEnv.isWindows || settings.windowsShell === "custom");
</script>

<div class="mt-2">
  <span class="flex items-center gap-1 text-xs text-muted">
    {t("settings.localShell")}<InfoHint text={t("settings.localShellHint")} />
  </span>
  {#if hostEnv.isWindows}
    <select
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      data-testid="windows-shell-select"
      bind:value={settings.windowsShell}
    >
      <option value="cmd">{t("settings.localShellCmd")}</option>
      <option value="powershell">{t("settings.localShellPowershell")}</option>
      <option value="pwsh"
        >{t("settings.localShellPwsh")}{pwshAvailable
          ? ""
          : ` — ${t("settings.localShellNotFound")}`}</option
      >
      <option value="custom">{t("settings.localShellCustom")}</option>
    </select>
    {#if settings.windowsShell === "pwsh" && !pwshAvailable}
      <p class="mt-1 text-xs text-danger" transition:slide={motion(MOTION_BASE)}>{t("settings.localShellPwshMissing")}</p>
    {/if}
  {/if}
  {#if showCustomPath}
    <input
      type="text"
      spellcheck="false"
      placeholder={hostEnv.isWindows ? "C:\\path\\to\\shell.exe" : "$SHELL"}
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      data-testid="local-shell-path"
      bind:value={settings.localShellPath}
      transition:slide={motion(MOTION_BASE)}
    />
    {#if !customValid}
      <p class="mt-1 text-xs text-danger" transition:slide={motion(MOTION_BASE)}>{t("settings.localShellNotFound")}</p>
    {/if}
  {/if}
</div>
