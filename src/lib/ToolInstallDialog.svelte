<script lang="ts">
  // Install a server tool (Phase 12.8): shows the resolved command and offers two
  // transparent paths — type it into the active terminal (user runs + sees output),
  // or run it here via sudo (password fed over stdin). Opened from Settings and the
  // lint "not installed" CTA.
  //
  // Phase 20.14: a long `apt install` used to only flip the button label, feeling
  // dead. Now the sudo path streams live output into a terminal-style console
  // (`install://out/{id}` events), shows a spinner + indeterminate bar while running,
  // and ends on an explicit success state; the parent auto-refreshes the catalogue.
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import { runToolInstall, installOutputEvent } from "./api";
  import { commandNeedsSudo, type ToolStatus } from "./servertools";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { listen } from "@tauri-apps/api/event";
  import { t } from "./i18n";

  let {
    open = false,
    sessionId,
    tool,
    onRunInTerminal,
    onInstalled,
    onclose,
  }: {
    open?: boolean;
    sessionId: string;
    tool: ToolStatus | null;
    /** Type the command into the active terminal (parent owns the terminal). */
    onRunInTerminal: (command: string) => void;
    /** Called after a sudo install finishes, so the catalogue can refresh. */
    onInstalled?: () => void;
    onclose?: () => void;
  } = $props();

  let sudoPw = $state("");
  let installing = $state(false);
  let done = $state(false);
  let consoleText = $state("");
  let consoleEl = $state<HTMLElement>();

  const command = $derived(tool?.command ?? "");
  const needsSudo = $derived(command ? commandNeedsSudo(command) : false);

  // Fresh tool (or reopen) → clear the previous run's console + success state.
  $effect(() => {
    void tool;
    consoleText = "";
    done = false;
  });

  // Keep the console pinned to the newest output as it streams in.
  $effect(() => {
    void consoleText;
    if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
  });

  function runInTerminal() {
    if (command) onRunInTerminal(command);
    onclose?.();
  }

  async function installViaSudo() {
    if (!command || installing) return;
    installing = true;
    done = false;
    consoleText = "";
    const unlisten = await listen<string>(installOutputEvent(sessionId), (e) => {
      consoleText += e.payload;
    });
    try {
      await runToolInstall(sessionId, command, needsSudo ? sudoPw : undefined);
      done = true;
      notifySuccess(t("servertools.installDone", { name: tool?.name ?? "" }));
      onInstalled?.();
    } catch (e) {
      notifyError(String(e));
    } finally {
      unlisten();
      installing = false;
    }
  }
</script>

<Modal
  {open}
  title={t("servertools.installTitle", { name: tool?.name ?? "" })}
  width="w-[90vw] max-w-xl"
  {onclose}
>
  {#if command}
    <p class="mb-2 text-xs text-muted">{t("servertools.commandLabel")}</p>
    <pre
      class="mb-3 overflow-x-auto rounded border border-edge bg-panel px-2 py-1.5 text-xs text-white">{command}</pre>

    {#if needsSudo && !installing && !done}
      <PasswordInput
        testid="install-sudo-password"
        class="mb-3"
        placeholder={t("editor.sudoPassword")}
        bind:value={sudoPw}
      />
    {/if}

    {#if installing || done}
      <div class="mb-2 flex items-center gap-2 text-xs" data-testid="install-progress">
        {#if installing}
          <Icon name="refresh" size={13} class="animate-spin text-accent" />
          <span class="text-muted">{t("servertools.installing")}</span>
        {:else}
          <Icon name="check" size={14} class="text-green-500" />
          <span class="text-green-500">{t("servertools.installDone", { name: tool?.name ?? "" })}</span>
        {/if}
      </div>
      {#if installing}
        <div class="mb-3 h-1 overflow-hidden rounded bg-edge">
          <div class="install-bar h-full w-1/3 rounded bg-accent"></div>
        </div>
      {/if}
    {/if}

    {#if installing || consoleText}
      <pre
        bind:this={consoleEl}
        data-testid="install-console"
        class="mb-3 max-h-48 min-h-16 overflow-auto whitespace-pre-wrap rounded border border-edge bg-panel-alt px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted"
      >{consoleText}{#if installing}<span class="install-cursor text-accent">▋</span>{/if}</pre>
    {/if}

    <div class="flex flex-wrap justify-end gap-2">
      <button class="rounded px-3 py-1 text-sm text-muted hover:text-white" onclick={() => onclose?.()}>
        {done ? t("common.done") : t("common.cancel")}
      </button>
      {#if !installing && !done}
        <button
          class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
          onclick={runInTerminal}
        >
          {t("servertools.runInTerminal")}
        </button>
        <button
          class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-40"
          onclick={installViaSudo}
        >
          {t("servertools.installSudo")}
        </button>
      {:else if installing}
        <button
          class="flex items-center gap-2 rounded bg-green-600 px-3 py-1 text-sm font-medium text-white opacity-60"
          disabled
        >
          <Icon name="refresh" size={13} class="animate-spin" />
          {t("servertools.installing")}
        </button>
      {/if}
    </div>
  {:else}
    <p class="text-xs text-muted">{t("servertools.noCommand")}</p>
  {/if}
</Modal>

<style>
  /* Indeterminate sweep — no known duration for a remote install, so show motion
     without a false percentage. Collapsed by the global reduce-motion guard. */
  .install-bar {
    animation: install-sweep 1.3s ease-in-out infinite;
  }
  @keyframes install-sweep {
    0% {
      transform: translateX(-110%);
    }
    100% {
      transform: translateX(360%);
    }
  }
  .install-cursor {
    animation: install-blink 1s step-end infinite;
  }
  @keyframes install-blink {
    50% {
      opacity: 0;
    }
  }
</style>
