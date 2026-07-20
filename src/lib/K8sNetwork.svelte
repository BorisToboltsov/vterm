<script lang="ts">
  // Network view for the k8s panel (Phase 37.1): Services + Ingress in one tab
  // (two sections, like DockerNetworks). Services expose a **port-forward** action
  // (runs `kubectl port-forward` in a real terminal, not `kubectl_run`). Describe/
  // YAML/delete live in the right-click menu. Presentational + action wiring; arg
  // building is pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { deleteArgs, type K8sService, type K8sIngress } from "./k8s";
  import type { MenuItem } from "./ctxmenu";
  import { t } from "./i18n";

  let {
    services,
    ingresses,
    busy = false,
    run,
    onDescribe,
    onYaml,
    onPortForward,
    showMenu,
  }: {
    services: K8sService[];
    ingresses: K8sIngress[];
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    onDescribe: (kind: string, name: string, namespace: string) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    onPortForward: (target: string, namespace: string, port: number) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  function svcMenu(s: K8sService): MenuItem[] {
    const items: MenuItem[] = [
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe("service", s.name, s.namespace) },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("service", s.name, s.namespace) },
    ];
    if (s.firstPort !== null) {
      items.push({
        icon: "network",
        label: t("k8s.portForward"),
        onSelect: () => onPortForward(`svc/${s.name}`, s.namespace, s.firstPort!),
      });
    }
    items.push(
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copy(s.name) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs("service", s.name), s.namespace, { successKey: "k8s.deleted" }) },
    );
    return items;
  }

  function ingMenu(i: K8sIngress): MenuItem[] {
    return [
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe("ingress", i.name, i.namespace) },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("ingress", i.name, i.namespace) },
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copy(i.name) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs("ingress", i.name), i.namespace, { successKey: "k8s.deleted" }) },
    ];
  }
</script>

<div class="h-full overflow-auto text-xs">
  <!-- Services -->
  <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
    <Icon name="network" size={13} class="text-accent" />
    <span class="font-medium text-white/85">{t("k8s.services")}</span>
    <span class="text-caption text-muted">{services.length}</span>
  </div>
  {#if services.length === 0}
    <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noServices")}</div>
  {:else}
    {#each services as s (`${s.namespace}/${s.name}`)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 hover:bg-edge/30"
        oncontextmenu={(e) => showMenu(e, svcMenu(s))}
        role="listitem"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{s.name}</span>
            <span class="shrink-0 text-caption text-muted">{s.type}</span>
            <span class="shrink-0 text-caption text-muted">{s.namespace}</span>
          </div>
          <div class="truncate text-caption text-muted">
            {s.clusterIp}{#if s.externalIp && s.externalIp !== "-"} · {s.externalIp}{/if}{#if s.ports} · {s.ports}{/if}
          </div>
        </div>
        <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{s.age}</span>
        {#if s.firstPort !== null}
          <button
            class="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-edge hover:text-white group-hover:opacity-100"
            use:tooltip={t("k8s.portForward")}
            aria-label={t("k8s.portForward")}
            onclick={() => onPortForward(`svc/${s.name}`, s.namespace, s.firstPort!)}
          >
            <Icon name="network" size={14} />
          </button>
        {/if}
      </div>
    {/each}
  {/if}

  <!-- Ingress -->
  <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
    <Icon name="gateway" size={13} class="text-accent" />
    <span class="font-medium text-white/85">{t("k8s.ingress")}</span>
    <span class="text-caption text-muted">{ingresses.length}</span>
  </div>
  {#if ingresses.length === 0}
    <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noIngress")}</div>
  {:else}
    {#each ingresses as i (`${i.namespace}/${i.name}`)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 hover:bg-edge/30"
        oncontextmenu={(e) => showMenu(e, ingMenu(i))}
        role="listitem"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{i.name}</span>
            {#if i.className}<span class="shrink-0 text-caption text-muted">{i.className}</span>{/if}
            <span class="shrink-0 text-caption text-muted">{i.namespace}</span>
          </div>
          <div class="truncate text-caption text-muted">
            {i.hosts}{#if i.address} · {i.address}{/if}
          </div>
        </div>
        <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{i.age}</span>
      </div>
    {/each}
  {/if}
</div>
