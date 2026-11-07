<script lang="ts">
  // A compose stack's details (v1.33, stage 5): its services — with containers
  // or declared and never created — and what each is doing; the actions on one
  // service; the stack's log, of every service or of one; its configuration as
  // compose renders it from the files the stack was brought up with, values that
  // look like secrets masked. Content only — it stands inside the panel's query
  // container and owns no dialog (`panelcontainer.guard`); the model is
  // `dockerstack.ts`, every mutation goes through the panel's `run` (confirmed).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import type { LogTailSize } from "../ui/loglines";
  import { tooltip } from "../actions/tooltip";
  import { redactSecrets } from "../ai/redact";
  import { stateTone } from "./docker";
  import {
    parseServiceNames,
    parseStackPs,
    serviceActionArgs,
    serviceLogsArgs,
    serviceSummary,
    serviceUpArgs,
    serviceUpCommand,
    stackConfigArgs,
    stackPsArgs,
    stackServices,
    usesOwnFiles,
    type DockerStack,
    type ServiceAction,
    type StackService,
  } from "./dockerstack";
  import type { ContainerOutput } from "../api";
  import { t, type MessageKey } from "../i18n";

  let {
    stack,
    active = true,
    busy = false,
    refreshSec = 3,
    fill = false,
    run,
    runQuery,
    onopen,
  }: {
    stack: DockerStack | null;
    /** On screen: asks and re-asks only then. */
    active?: boolean;
    busy?: boolean;
    refreshSec?: number;
    fill?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string; label?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    /** Open a container's details. */
    onopen: (id: string) => void;
  } = $props();

  type Tab = "services" | "logs" | "config";
  let tab = $state<Tab>("services");
  let services = $state<StackService[] | undefined>(undefined);
  // The files could not be read: what has no container is not known (said in words).
  let declaredUnread = $state(false);
  let logsText = $state("");
  let following = $state(true);
  let tail = $state<LogTailSize>(200);
  let logService = $state<string>("");
  let configText = $state<string | null | undefined>(undefined);
  let showSecrets = $state(false);

  async function loadServices(s: DockerStack) {
    const [ps, cfg] = await Promise.allSettled([runQuery(stackPsArgs(s.project)), runQuery(stackConfigArgs(s, true), 30)]);
    if (stack?.project !== s.project) return;
    const rows = ps.status === "fulfilled" && ps.value.exitCode === 0 ? parseStackPs(ps.value.stdout) : [];
    const declared = cfg.status === "fulfilled" && cfg.value.exitCode === 0 ? parseServiceNames(cfg.value.stdout) : null;
    declaredUnread = declared == null;
    services = stackServices(declared, rows);
  }
  async function loadLogs(s: DockerStack, service: string, lines: number) {
    const res = await runQuery(serviceLogsArgs(s.project, service || null, lines), 30);
    if (stack?.project === s.project) logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function loadConfig(s: DockerStack) {
    try {
      const res = await runQuery(stackConfigArgs(s), 30);
      if (stack?.project !== s.project) return;
      // compose's own words when it cannot render the stack — they say what is missing.
      configText = res.exitCode === 0 ? res.stdout : null;
      if (res.exitCode !== 0) configError = (res.stderr || res.stdout).trim();
    } catch (e) {
      configText = null;
      configError = String(e);
    }
  }
  let configError = $state("");

  // A different stack: from the top, nothing of the last one shown.
  let shown: string | null = null;
  $effect(() => {
    const p = stack?.project ?? null;
    if (p === shown) return;
    shown = p;
    services = undefined;
    logsText = "";
    configText = undefined;
    configError = "";
    showSecrets = false;
    logService = "";
  });
  $effect(() => {
    const s = stack;
    if (!active || !s || tab !== "services") return;
    void loadServices(s);
    const timer = setInterval(() => void loadServices(s), Math.max(5, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const s = stack;
    const svc = logService;
    const lines = tail;
    if (!active || !s || tab !== "logs") return;
    void loadLogs(s, svc, lines);
    if (!following) return;
    const timer = setInterval(() => void loadLogs(s, svc, lines), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const s = stack;
    if (!active || !s || tab !== "config") return;
    void loadConfig(s);
  });

  const ownFiles = $derived(stack ? usesOwnFiles(stack) : false);
  const shownConfig = $derived(configText == null ? "" : showSecrets ? configText : redactSecrets(configText).text);
  const masked = $derived(configText ? redactSecrets(configText).count : 0);

  async function act(s: StackService, action: ServiceAction) {
    if (!stack) return;
    await run(serviceActionArgs(stack.project, action, s.name), {
      successKey: action === "start" ? "docker.started" : action === "stop" ? "docker.stopped" : "docker.restarted",
    });
    void loadServices(stack);
  }
  async function up(s: StackService) {
    if (!stack) return;
    await run(serviceUpArgs(stack, s.name), { successKey: "docker.started" });
    void loadServices(stack);
  }
  function logsOf(s: StackService) {
    logService = s.name;
    tab = "logs";
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "services", label: "docker.stackServices" },
    { id: "logs", label: "docker.viewLogs" },
    { id: "config", label: "docker.stackConfig" },
  ];
  const TEXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted" };
  const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
  const BTN = "rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40";
</script>

{#if stack}
  <div class="flex min-h-0 flex-1 flex-col text-meta" data-testid="docker-stack-detail">
    <!-- Where the stack comes from: what `config` reads, what `up` would read. -->
    <div class="mb-2 space-y-0.5">
      {#if stack.workdir}<div class="truncate font-mono text-caption text-muted" use:tooltip={stack.workdir}>{stack.workdir}</div>{/if}
      {#each stack.files as f (f)}
        <div class="truncate font-mono text-caption text-text/85" use:tooltip={f}>{f.split("/").pop()}</div>
      {/each}
      {#if stack.envFile}<div class="truncate font-mono text-caption text-muted" use:tooltip={stack.envFile}>{t("docker.stackEnvFile", { name: stack.envFile.split("/").pop() ?? "" })}</div>{/if}
    </div>

    <div class="mb-2 flex border-b border-edge">
      {#each TABS as tb (tb.id)}
        <button
          data-testid={`docker-stack-tab-${tb.id}`}
          class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
          aria-current={tab === tb.id ? "true" : undefined}
          onclick={() => (tab = tb.id)}
        >{t(tb.label)}</button>
      {/each}
    </div>

    {#if tab === "services"}
      <div class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto" data-testid="docker-stack-services">
        {#if services === undefined}
          <p class="text-muted">…</p>
        {:else}
          {#each services as s (s.name)}
            {@const sum = serviceSummary(s)}
            {@const running = s.containers.some((c) => c.state === "running")}
            <div class="group border-b border-edge/60 py-1" data-testid="docker-stack-service">
              <div class="flex min-w-0 items-center gap-2">
                <span class="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {DOT[sum.tone]}"></span>
                <span class="min-w-0 truncate font-medium text-text/90">{s.name}</span>
                <span class="shrink-0 text-caption {TEXT[sum.tone]}">{s.containers.length === 0 ? t("docker.svcNotCreated") : sum.word}</span>
                {#if !s.declared}<span class="shrink-0 text-caption text-warn" use:tooltip={t("docker.svcUndeclaredHint")}>{t("docker.svcUndeclared")}</span>{/if}
                <span class="flex-1"></span>
                <div class="flex shrink-0 items-center gap-0.5 text-muted">
                  {#if s.containers.length === 0}
                    {#if ownFiles}
                      <!-- `up` from the project's directory would read another definition:
                           the command with the stack's own files is offered to copy instead. -->
                      <span class="text-caption text-muted" use:tooltip={t("docker.svcUpOwnFiles")}>{t("docker.svcUpByHand")}</span>
                      <CopyButton text={serviceUpCommand(stack, s.name)} testid="docker-stack-up-copy" />
                    {:else}
                      <button class={BTN} disabled={busy} use:tooltip={t("docker.svcUp")} aria-label={t("docker.svcUp")} data-testid="docker-stack-up" onclick={() => up(s)}><Icon name="play" size={13} /></button>
                    {/if}
                  {:else}
                    {#if running}
                      <button class={BTN} disabled={busy} use:tooltip={t("docker.stop")} aria-label={t("docker.stop")} data-testid="docker-stack-stop" onclick={() => act(s, "stop")}><Icon name="stop" size={13} /></button>
                    {:else}
                      <button class={BTN} disabled={busy} use:tooltip={t("docker.start")} aria-label={t("docker.start")} data-testid="docker-stack-start" onclick={() => act(s, "start")}><Icon name="play" size={13} /></button>
                    {/if}
                    <button class={BTN} disabled={busy} use:tooltip={t("docker.restart")} aria-label={t("docker.restart")} data-testid="docker-stack-restart" onclick={() => act(s, "restart")}><Icon name="refresh" size={12} /></button>
                    <button class={BTN} use:tooltip={t("docker.viewLogs")} aria-label={t("docker.viewLogs")} data-testid="docker-stack-logs" onclick={() => logsOf(s)}><Icon name="note" size={12} /></button>
                  {/if}
                </div>
              </div>
              {#each s.containers as c (c.id || c.name)}
                <button type="button" class="flex w-full min-w-0 items-center gap-2 rounded py-0.5 pl-4 pr-1 text-left hover:bg-edge/30" onclick={() => onopen(c.id)}>
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full {DOT[stateTone(c.state)]}"></span>
                  <span class="min-w-0 truncate text-caption text-muted">{c.name}</span>
                  <span class="shrink-0 text-caption text-muted">{c.health || c.state}</span>
                </button>
              {/each}
            </div>
          {/each}
          {#if declaredUnread}
            <!-- Without the files the panel knows only the services that have containers. -->
            <p class="mt-1 text-caption text-muted" data-testid="docker-stack-undeclared-unknown">{t("docker.stackFilesUnread")}</p>
          {/if}
        {/if}
      </div>
    {:else if tab === "logs"}
      <LogTail text={logsText} bind:live={following} bind:tail {fill} empty={t("docker.noLogs")} testid="docker-stack">
        <label class="flex shrink-0 items-center gap-1 text-meta text-muted">
          {t("docker.stackService")}
          <select class="rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text outline-none focus:border-accent" bind:value={logService} data-testid="docker-stack-log-service">
            <option value="">{t("docker.stackAllServices")}</option>
            {#each services ?? [] as s (s.name)}
              <option value={s.name}>{s.name}</option>
            {/each}
          </select>
        </label>
      </LogTail>
    {:else}
      <div class="mb-1 flex items-center justify-end gap-2">
        {#if masked > 0}
          <button type="button" class="rounded px-1 text-caption text-muted hover:bg-edge hover:text-text" aria-pressed={showSecrets} data-testid="docker-stack-config-reveal" onclick={() => (showSecrets = !showSecrets)}>
            {t(showSecrets ? "docker.envHide" : "docker.envShow")}
          </button>
        {/if}
        <CopyButton text={shownConfig} label={t("util.copy")} testid="docker-stack-config-copy" />
      </div>
      <pre
        data-testid="docker-stack-config"
        class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
      >{configText === undefined ? "…" : configText === null ? configError || t("docker.stackConfigUnread") : shownConfig}</pre>
    {/if}
  </div>
{/if}
