<script lang="ts">
  // Servers of the catalog to run on (ADR 0071): by folder, prod marked, each
  // saying whether its session is open or will be opened for the run. Shared by
  // a recipe's run and the "from the catalog" part of a playbook run.
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import FilterField from "../ui/FilterField.svelte";
  import Icon from "../ui/Icon.svelte";
  import type { ServerProfile } from "../types";
  import { defaultUser } from "../servers/logins";

  let {
    servers,
    selected = $bindable([]),
    connected,
    hideStatus = false,
    testid = "target-picker",
  }: {
    servers: ServerProfile[];
    /** Ids of the servers picked. */
    selected?: string[];
    /** Servers whose session is open now. */
    connected: ReadonlySet<string>;
    /** No "open / will connect" column (the playbook's hosts are Ansible's to reach). */
    hideStatus?: boolean;
    testid?: string;
  } = $props();

  let query = $state("");
  const shown = $derived(
    servers.filter((s) => {
      const q = query.trim().toLowerCase();
      return !q || [s.alias, s.host, s.group ?? "", ...s.tags].some((x) => x.toLowerCase().includes(q));
    }),
  );
  const folders = $derived.by(() => {
    const out = new Map<string, ServerProfile[]>();
    for (const s of shown) out.set(s.group ?? "", [...(out.get(s.group ?? "") ?? []), s]);
    return [...out.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  });

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }

  function toggleFolder(list: ServerProfile[]) {
    const ids = list.map((s) => s.id);
    const all = ids.every((id) => selected.includes(id));
    selected = all ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])];
  }
</script>

<div class="flex min-h-0 flex-col" data-testid={testid}>
  <FilterField bind:value={query} placeholder={t("scenarios.targets.filter")} shown={shown.length} total={servers.length} />
  <div class="mt-1 max-h-56 min-h-0 overflow-y-auto rounded border border-edge">
    {#if servers.length === 0}
      <div class="px-2 py-2 text-xs text-muted">{t("scenarios.targets.none")}</div>
    {/if}
    {#each folders as [folder, list] (folder)}
      {#if folder}
        <button
          type="button"
          class="flex w-full items-center gap-1.5 border-b border-edge/50 bg-panel-alt px-2 py-0.5 text-left text-meta text-muted hover:text-text"
          onclick={() => toggleFolder(list)}
        >
          <Icon name="folder" size={11} />{folder}
          <span class="ml-auto">{list.filter((s) => selected.includes(s.id)).length}/{list.length}</span>
        </button>
      {/if}
      {#each list as s (s.id)}
        {@const prod = isProdServer(s)}
        <label class="flex cursor-pointer items-center gap-2 border-b border-edge/40 px-2 py-1 text-xs hover:bg-edge/30" data-testid="target-row">
          <input type="checkbox" checked={selected.includes(s.id)} onchange={() => toggle(s.id)} />
          <span class="min-w-0 truncate text-text">{s.alias}</span>
          {#if prod}<span class="rounded bg-danger/15 px-1 text-caption text-danger">prod</span>{/if}
          <span class="min-w-0 truncate text-meta text-muted">{defaultUser(s)}@{s.host}{s.port === 22 ? "" : `:${s.port}`}</span>
          {#if !hideStatus}
            <span class="ml-auto shrink-0 text-caption {connected.has(s.id) ? 'text-ok' : 'text-muted'}">
              {connected.has(s.id) ? t("scenarios.targets.open") : t("scenarios.targets.willConnect")}
            </span>
          {/if}
        </label>
      {/each}
    {/each}
  </div>
</div>
