<script lang="ts">
  // Utilities → Base64 / URL / Hex codec (Phase 33). All conversion is pure logic
  // in codec.ts; this component is just the form (format + direction + text areas)
  // and live output. Fully offline — no backend, no network.
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { t, type MessageKey } from "./i18n";
  import { runCodec, type CodecKind, type CodecDir, type CodecError } from "./codec";

  const FORMATS: { id: CodecKind; label: MessageKey }[] = [
    { id: "base64", label: "util.codec.formatBase64" },
    { id: "base64url", label: "util.codec.formatBase64url" },
    { id: "url", label: "util.codec.formatUrl" },
    { id: "hex", label: "util.codec.formatHex" },
  ];
  const ERR: Record<CodecError, MessageKey> = {
    invalidBase64: "util.codec.invalidBase64",
    invalidHex: "util.codec.invalidHex",
    invalidUrl: "util.codec.invalidUrl",
  };

  let kind = $state<CodecKind>("base64");
  let dir = $state<CodecDir>("encode");
  let input = $state("");

  const result = $derived(runCodec(kind, dir, input));
  const output = $derived(result.ok ? result.value : "");

  // Swap: feed the current output back as input and flip the direction, so a user
  // can chain encode → decode to verify a round-trip.
  function swap() {
    if (!result.ok) return;
    input = output;
    dir = dir === "encode" ? "decode" : "encode";
  }
</script>

<div class="space-y-3 text-xs text-muted">
  <div class="flex flex-wrap items-end gap-3">
    <label class="block">
      {t("util.codec.format")}
      <select
        data-testid="codec-format"
        class="mt-1 block rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
        bind:value={kind}
      >
        {#each FORMATS as f (f.id)}
          <option value={f.id}>{t(f.label)}</option>
        {/each}
      </select>
    </label>

    <div>
      <span class="block">{t("util.codec.direction")}</span>
      <div class="mt-1 inline-flex overflow-hidden rounded border border-edge">
        <button
          type="button"
          data-testid="codec-encode"
          class="px-3 py-1 text-sm {dir === 'encode' ? 'bg-accent text-panel-alt' : 'text-muted hover:bg-edge'}"
          onclick={() => (dir = "encode")}>{t("util.codec.encode")}</button
        >
        <button
          type="button"
          data-testid="codec-decode"
          class="px-3 py-1 text-sm {dir === 'decode' ? 'bg-accent text-panel-alt' : 'text-muted hover:bg-edge'}"
          onclick={() => (dir = "decode")}>{t("util.codec.decode")}</button
        >
      </div>
    </div>

    <button
      type="button"
      data-testid="codec-swap"
      class="flex items-center gap-1 rounded px-2 py-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
      onclick={swap}
      disabled={!result.ok || output === ""}
      aria-label={t("util.codec.swap")}
    >
      <Icon name="arrowsUpDown" size={14} />
    </button>
  </div>

  <label class="block">
    {t("util.codec.input")}
    <textarea
      data-testid="codec-input"
      rows="4"
      class="mt-1 w-full resize-y break-all rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
      bind:value={input}
    ></textarea>
  </label>

  <div>
    <div class="mb-1 flex items-center justify-between">
      <span>{t("util.codec.output")}</span>
      <CopyButton text={output} testid="codec-copy" />
    </div>
    {#if !result.ok}
      <p class="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-meta text-danger" data-testid="codec-error">
        {t(ERR[result.error])}
      </p>
    {:else}
      <textarea
        readonly
        data-testid="codec-output"
        rows="4"
        class="w-full resize-y break-all rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text outline-none"
        value={output}
      ></textarea>
    {/if}
  </div>
</div>
