<script lang="ts">
  // Utilities → TLS/SSL inspector (Phase 34). Fetches a leaf certificate from
  // host:port on the session host and shows its subject/issuer/SAN and — the
  // point of the tool — how many days until it expires. All building/parsing is
  // pure logic in tls.ts; this is the form + a cert card. See UtilProbeRunner.
  import CopyButton from "./CopyButton.svelte";
  import UtilProbeRunner from "./UtilProbeRunner.svelte";
  import { t, type MessageKey } from "./i18n";
  import { isValidHost, isValidPort } from "./serverform";
  import { tlsArgs, parseTlsCert, expiryLevel, type TlsExpiry } from "./tls";
  import type { ProbeSession } from "./probe";
  import type { ProbeOutput } from "./api";

  let { session }: { session: ProbeSession | null } = $props();

  let host = $state("");
  let port = $state(443);

  const args = $derived(
    isValidHost(host.trim()) && isValidPort(port) ? tlsArgs(host, port) : null,
  );

  const EXPIRY_CLASS: Record<TlsExpiry, string> = {
    expired: "bg-danger/20 text-danger",
    critical: "bg-danger/15 text-danger",
    warning: "bg-warn/20 text-warn",
    ok: "bg-accent/20 text-accent",
    unknown: "bg-edge text-muted",
  };
  const EXPIRY_LABEL: Record<TlsExpiry, MessageKey> = {
    expired: "util.tls.expired",
    critical: "util.tls.expiresSoon",
    warning: "util.tls.expiresSoon",
    ok: "util.tls.valid",
    unknown: "util.tls.unknown",
  };
</script>

<UtilProbeRunner {session} {args} timeoutSecs={15}>
  {#snippet form()}
    <div class="flex flex-wrap items-end gap-2">
      <label class="block">
        {t("util.tls.host")}
        <input
          data-testid="tls-host"
          class="mt-1 w-56 rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
          placeholder="example.com"
          bind:value={host}
        />
      </label>
      <label class="block">
        {t("util.tls.port")}
        <input
          data-testid="tls-port"
          type="number"
          min="1"
          max="65535"
          class="mt-1 w-24 rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
          bind:value={port}
        />
      </label>
    </div>
  {/snippet}

  {#snippet result(out: ProbeOutput)}
    {@const cert = parseTlsCert(out.stdout)}
    {#if cert}
      {@const level = expiryLevel(cert.daysRemaining)}
      <div class="space-y-2" data-testid="tls-cert">
        <div class="flex items-center gap-2">
          <span class="rounded px-2 py-0.5 text-[11px] {EXPIRY_CLASS[level]}" data-testid="tls-expiry">
            {t(EXPIRY_LABEL[level])}
          </span>
          {#if cert.daysRemaining !== null}
            <span class="text-[11px] text-muted">
              {t("util.tls.daysLeft", { days: cert.daysRemaining })}
            </span>
          {/if}
        </div>
        <table class="w-full max-w-xl">
          <tbody>
            {#each [["util.tls.subject", cert.subject], ["util.tls.issuer", cert.issuer], ["util.tls.notBefore", cert.notBefore], ["util.tls.notAfter", cert.notAfter], ["util.tls.serial", cert.serial], ["util.tls.fingerprint", cert.fingerprint]] as [key, value] (key)}
              {#if value}
                <tr class="border-b border-edge/50 align-top">
                  <td class="py-1 pr-3 text-muted">{t(key as MessageKey)}</td>
                  <td class="py-1 font-mono text-[11px] break-all text-white">{value}</td>
                  <td class="py-1 pl-2 text-right"><CopyButton text={value} /></td>
                </tr>
              {/if}
            {/each}
            {#if cert.sans.length}
              <tr class="align-top">
                <td class="py-1 pr-3 text-muted">{t("util.tls.san")}</td>
                <td class="py-1 font-mono text-[11px] break-all text-white">{cert.sans.join(", ")}</td>
                <td class="py-1 pl-2 text-right"><CopyButton text={cert.sans.join(", ")} /></td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {:else}
      <pre class="whitespace-pre-wrap rounded border border-edge bg-panel p-2 font-mono text-[11px] text-muted" data-testid="tls-raw">{out.stderr || out.stdout || t("util.probe.noOutput")}</pre>
    {/if}
  {/snippet}
</UtilProbeRunner>
