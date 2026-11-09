<script lang="ts">
  // ConfigMaps and Secrets (v1.36, ADR 0061): one list, grouped by kind. A
  // ConfigMap says how many keys it has, a Secret its type. A click opens the
  // details — beside the list in a wide panel, a dialog in a narrow one. YAML is
  // offered for a ConfigMap only: of a Secret the backend reads nothing but keys.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import type { ListGroup } from "../ui/listview";
  import type { MenuItem } from "../ui/ctxmenu";
  import type { IconName } from "../ui/icons";
  import type { K8sConfig } from "./k8s";
  import { t } from "../i18n";

  let {
    groups,
    grouped = true,
    grouping = "kind",
    collapsed = [],
    ontoggle = () => {},
    onOpen,
    onYaml,
    showMenu,
    selectedKey = null,
  }: {
    groups: ListGroup<K8sConfig>[];
    grouped?: boolean;
    grouping?: string;
    collapsed?: readonly string[];
    ontoggle?: (key: string) => void;
    onOpen: (c: K8sConfig) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
    /** `kind/namespace/name` of the one whose details are open. */
    selectedKey?: string | null;
  } = $props();

  const KIND_ICON: Record<string, IconName> = { ConfigMap: "settings", Secret: "key" };
  const keyOf = (c: K8sConfig) => `${c.kind}/${c.namespace}/${c.name}`;

  function menuItems(c: K8sConfig): MenuItem[] {
    const items: MenuItem[] = [{ icon: "eye", label: t("k8s.viewDetails"), onSelect: () => onOpen(c) }];
    if (c.kind === "ConfigMap") {
      items.push({ icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("configmap", c.name, c.namespace) });
    }
    items.push({ kind: "separator" }, { icon: "copy", label: t("k8s.copyName"), onSelect: () => void navigator.clipboard?.writeText(c.name) });
    return items;
  }
</script>

<div class="h-full overflow-auto text-xs">
  {#each groups as g (g.key)}
    {@const folded = grouped && collapsed.includes(g.key)}
    {#if grouped}
      <GroupHeader
        label={g.label}
        count={g.items.length}
        collapsed={folded}
        ontoggle={() => ontoggle(g.key)}
        icon={grouping === "kind" ? (KIND_ICON[g.key] ?? "note") : undefined}
        testid="k8s-config-group"
      />
    {/if}
    {#each folded ? [] : g.items as c (keyOf(c))}
      <!-- A click opens the details; the keyboard has the row's own button for it. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        class="group flex cursor-default items-center gap-2 border-b border-edge/60 py-1.5 pr-2 {grouped ? 'pl-5' : 'pl-2.5'} {selectedKey === keyOf(c) ? 'bg-accent/10' : 'hover:bg-edge/30'}"
        oncontextmenu={(e) => showMenu(e, menuItems(c))}
        onclick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) onOpen(c);
        }}
        role="listitem"
        aria-current={selectedKey === keyOf(c) ? "true" : undefined}
        data-testid="k8s-config-row"
      >
        {#if !grouped || grouping !== "kind"}
          <Icon name={KIND_ICON[c.kind]} size={12} class="shrink-0 text-muted" />
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-text/90">{c.name}</span>
            <span class="shrink-0 text-caption text-muted">{c.namespace}</span>
          </div>
          {#if c.type}
            <div class="mt-0.5 truncate font-mono text-caption text-muted">{c.type}</div>
          {/if}
        </div>
        <span class="shrink-0 text-meta tabular-nums text-muted" use:tooltip={t("k8s.configKeys")}>{t("k8s.keysCount", { count: c.entries.length })}</span>
        <span class="shrink-0 text-caption tabular-nums text-muted" use:tooltip={t("k8s.age")}>{c.age}</span>
        <div class="flex shrink-0 items-center text-muted opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <button
            class="rounded p-1 hover:bg-edge hover:text-text"
            use:tooltip={t("k8s.viewDetails")}
            aria-label={t("k8s.viewDetails")}
            onclick={() => onOpen(c)}
            data-testid="k8s-config-open"
          >
            <Icon name="eye" size={13} />
          </button>
        </div>
      </div>
    {/each}
  {/each}
</div>
