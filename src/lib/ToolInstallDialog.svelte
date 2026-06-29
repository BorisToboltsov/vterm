<script lang="ts">
  // Install a server tool (Phase 12.8): shows the resolved command and offers two
  // transparent paths — type it into the active terminal (user runs + sees output),
  // or run it here via sudo (password fed over stdin). Opened from Settings and the
  // lint "not installed" CTA.
  import Modal from "./Modal.svelte";
  import { runToolInstall } from "./api";
  import { commandNeedsSudo, type ToolStatus } from "./servertools";
  import { notifyError } from "./stores/toasts.svelte";
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
  let output = $state("");

  const command = $derived(tool?.command ?? "");
  const needsSudo = $derived(command ? commandNeedsSudo(command) : false);

  function runInTerminal() {
    if (command) onRunInTerminal(command);
    onclose?.();
  }

  async function installViaSudo() {
    if (!command || installing) return;
    installing = true;
    output = "";
    try {
      output = await runToolInstall(sessionId, command, needsSudo ? sudoPw : undefined);
      onInstalled?.();
    } catch (e) {
      notifyError(String(e));
    } finally {
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

    {#if needsSudo}
      <input
        type="password"
        autocomplete="off"
        class="mb-3 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        placeholder={t("editor.sudoPassword")}
        bind:value={sudoPw}
      />
    {/if}

    {#if output}
      <pre
        class="mb-3 max-h-48 overflow-auto rounded border border-edge bg-panel px-2 py-1.5 text-[11px] text-muted">{output}</pre>
    {/if}

    <div class="flex flex-wrap justify-end gap-2">
      <button class="rounded px-3 py-1 text-sm text-muted hover:text-white" onclick={() => onclose?.()}>
        {t("common.cancel")}
      </button>
      <button
        class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
        onclick={runInTerminal}
      >
        {t("servertools.runInTerminal")}
      </button>
      <button
        class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-40"
        disabled={installing}
        onclick={installViaSudo}
      >
        {installing ? t("servertools.installing") : t("servertools.installSudo")}
      </button>
    </div>
  {:else}
    <p class="text-xs text-muted">{t("servertools.noCommand")}</p>
  {/if}
</Modal>
