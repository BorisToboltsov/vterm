<script lang="ts">
  // Utilities → CIDR / subnet calculator (Phase 33). All math is pure logic in
  // cidr.ts; this component is the input + a table of derived values and an
  // optional "is this IP in the block?" check. Offline, IPv4.
  import CopyButton from "./CopyButton.svelte";
  import { t, type MessageKey } from "./i18n";
  import { parseCidr, ipInCidr, type CidrError } from "./cidr";

  const ERR: Record<CidrError, MessageKey> = {
    empty: "util.cidr.errEmpty",
    invalidAddress: "util.cidr.errAddress",
    invalidPrefix: "util.cidr.errPrefix",
  };

  let input = $state("192.168.1.0/24");
  let testIp = $state("");

  const result = $derived(parseCidr(input));
  const contained = $derived(
    result.ok && testIp.trim() ? ipInCidr(result.info.cidr, testIp) : null,
  );

  // Rows shown for a valid block. Kept here (not in cidr.ts) since it's view data.
  const rows = $derived(
    result.ok
      ? ([
          ["util.cidr.network", result.info.network],
          ["util.cidr.broadcast", result.info.broadcast],
          ["util.cidr.netmask", result.info.netmask],
          ["util.cidr.wildcard", result.info.wildcard],
          ["util.cidr.range", `${result.info.firstHost} – ${result.info.lastHost}`],
          ["util.cidr.hostCount", result.info.hostCount.toLocaleString()],
          ["util.cidr.usableHosts", result.info.usableHosts.toLocaleString()],
        ] satisfies [MessageKey, string][])
      : [],
  );
</script>

<div class="space-y-3 text-xs text-muted">
  <label class="block">
    {t("util.cidr.input")}
    <input
      data-testid="cidr-input"
      class="mt-1 w-full max-w-xs rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
      placeholder="192.168.1.0/24"
      bind:value={input}
    />
  </label>

  {#if !result.ok}
    <p class="text-meta text-danger" data-testid="cidr-error">{t(ERR[result.error])}</p>
  {:else}
    <div class="flex items-center gap-2">
      <span class="font-mono text-sm text-white" data-testid="cidr-block">{result.info.cidr}</span>
      <span
        class="rounded px-1.5 py-0.5 text-caption {result.info.isPrivate
          ? 'bg-accent/20 text-accent'
          : 'bg-edge text-muted'}"
      >
        {result.info.isPrivate ? t("util.cidr.private") : t("util.cidr.public")}
      </span>
    </div>

    <table class="w-full max-w-md">
      <tbody>
        {#each rows as [key, value] (key)}
          <tr class="border-b border-edge/50">
            <td class="py-1 pr-3 text-muted">{t(key)}</td>
            <td class="py-1 font-mono text-white">{value}</td>
            <td class="py-1 pl-2 text-right"><CopyButton text={value} /></td>
          </tr>
        {/each}
      </tbody>
    </table>

    <label class="block pt-1">
      {t("util.cidr.contains")}
      <div class="mt-1 flex items-center gap-2">
        <input
          data-testid="cidr-testip"
          class="w-40 rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
          placeholder="192.168.1.42"
          bind:value={testIp}
        />
        {#if contained !== null}
          <span
            data-testid="cidr-contained"
            class="rounded px-2 py-0.5 text-meta {contained
              ? 'bg-accent/20 text-accent'
              : 'bg-danger/15 text-danger'}"
          >
            {contained ? t("util.cidr.contained") : t("util.cidr.notContained")}
          </span>
        {/if}
      </div>
    </label>
  {/if}
</div>
