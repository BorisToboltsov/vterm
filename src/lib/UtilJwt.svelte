<script lang="ts">
  // Utilities → JWT decoder (Phase 33). Decoding is pure logic in jwt.ts (no
  // signature verification, offline). This component pretty-prints the header and
  // payload and surfaces the standard time claims with a validity badge.
  import CopyButton from "./CopyButton.svelte";
  import { t, currentLocale, type MessageKey } from "./i18n";
  import { decodeJwt, claimDate, expiryStatus, type JwtError } from "./jwt";

  const ERR: Record<JwtError, MessageKey> = {
    empty: "util.jwt.errEmpty",
    structure: "util.jwt.errStructure",
    invalidBase64: "util.jwt.errBase64",
    invalidJson: "util.jwt.errJson",
  };

  let input = $state("");
  const result = $derived(decodeJwt(input));

  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "medium" }).format(d);

  const claims = $derived.by(() => {
    if (!result.ok || typeof result.parts.payload !== "object" || result.parts.payload === null) {
      return [] as [MessageKey, string][];
    }
    const p = result.parts.payload as Record<string, unknown>;
    const out: [MessageKey, string][] = [];
    for (const [claim, key] of [
      ["iat", "util.jwt.iat"],
      ["nbf", "util.jwt.nbf"],
      ["exp", "util.jwt.exp"],
    ] as [string, MessageKey][]) {
      const d = claimDate(p[claim]);
      if (d) out.push([key, fmt(d)]);
    }
    return out;
  });

  const expiry = $derived(result.ok ? expiryStatus(result.parts.payload) : null);
</script>

<div class="space-y-3 text-xs text-muted">
  <label class="block">
    {t("util.jwt.input")}
    <textarea
      data-testid="jwt-input"
      rows="4"
      class="mt-1 w-full resize-y break-all rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
      placeholder="eyJhbGciOi…"
      bind:value={input}
    ></textarea>
  </label>

  {#if input.trim() && !result.ok}
    <p class="text-meta text-danger" data-testid="jwt-error">{t(ERR[result.error])}</p>
  {:else if result.ok}
    {#if expiry}
      <span
        data-testid="jwt-expiry"
        class="inline-block rounded px-2 py-0.5 text-meta {expiry === 'expired'
          ? 'bg-danger/15 text-danger'
          : 'bg-accent/20 text-accent'}"
      >
        {expiry === "expired" ? t("util.jwt.expired") : t("util.jwt.valid")}
      </span>
    {/if}

    {#each [["util.jwt.header", result.parts.header], ["util.jwt.payload", result.parts.payload]] as [label, obj] (label)}
      <div>
        <div class="mb-1 flex items-center justify-between">
          <span class="font-medium text-text">{t(label as MessageKey)}</span>
          <CopyButton text={pretty(obj)} />
        </div>
        <pre
          data-testid={label === "util.jwt.header" ? "jwt-header" : "jwt-payload"}
          class="overflow-x-auto rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text">{pretty(obj)}</pre>
      </div>
    {/each}

    {#if claims.length}
      <div>
        <p class="mb-1 font-medium text-text">{t("util.jwt.claims")}</p>
        <table class="w-full max-w-md">
          <tbody>
            {#each claims as [key, value] (key)}
              <tr class="border-b border-edge/50">
                <td class="py-1 pr-3 text-muted">{t(key)}</td>
                <td class="py-1 font-mono text-text">{value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div>
      <p class="mb-1 font-medium text-text">{t("util.jwt.signature")}</p>
      <p class="break-all font-mono text-meta text-muted">{result.parts.signature}</p>
      <p class="mt-0.5 text-meta text-warn">{t("util.jwt.signatureNote")}</p>
    </div>
  {/if}
</div>
