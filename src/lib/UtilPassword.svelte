<script lang="ts">
  // Utilities → Password / passphrase generator (Phase 33). All randomness and
  // rules live in pwgen.ts (CSPRNG, offline); this component is the options form,
  // a strength meter and copy. A `seed` counter drives "regenerate" without
  // changing options.
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { t, type MessageKey } from "./i18n";
  import {
    generatePassword,
    generatePassphrase,
    type PwOptions,
    type PwResult,
    type PwError,
    type PassphraseResult,
  } from "./pwgen";

  const ERR: Record<PwError, MessageKey> = {
    noClass: "util.password.errNoClass",
    emptyPool: "util.password.errEmptyPool",
    lengthTooSmall: "util.password.errLengthTooSmall",
    unsatisfiable: "util.password.errUnsatisfiable",
  };

  let mode = $state<"password" | "passphrase">("password");
  let seed = $state(0);

  let opts = $state<PwOptions>({
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    exclude: "",
    requireEach: true,
    noRepeats: false,
  });

  let phraseOpts = $state({
    words: 5,
    separator: "-",
    capitalize: false,
    includeNumber: false,
  });

  let result = $state<PwResult>({ ok: true, password: "", entropyBits: 0 });
  let phrase = $state<PassphraseResult>({ phrase: "", entropyBits: 0 });

  // Regenerate whenever the options, mode or seed change. snapshot() reads every
  // field (so all are tracked) and hands pwgen a plain object.
  $effect(() => {
    seed;
    if (mode === "password") {
      result = generatePassword($state.snapshot(opts));
    } else {
      phrase = generatePassphrase($state.snapshot(phraseOpts));
    }
  });

  const value = $derived(
    mode === "password" ? (result.ok ? result.password : "") : phrase.phrase,
  );
  const bits = $derived(mode === "password" ? (result.ok ? result.entropyBits : 0) : phrase.entropyBits);
  const strength = $derived.by(() => {
    const pct = Math.min(100, Math.round((bits / 128) * 100));
    if (bits < 40) return { key: "util.password.strengthWeak" as MessageKey, cls: "bg-danger", pct };
    if (bits < 60) return { key: "util.password.strengthFair" as MessageKey, cls: "bg-warn", pct };
    if (bits < 80) return { key: "util.password.strengthStrong" as MessageKey, cls: "bg-accent", pct };
    return { key: "util.password.strengthVeryStrong" as MessageKey, cls: "bg-accent", pct };
  });
</script>

<div class="space-y-4 text-xs text-muted">
  <div class="inline-flex overflow-hidden rounded border border-edge">
    <button
      type="button"
      data-testid="pw-mode-password"
      class="px-3 py-1 text-sm {mode === 'password' ? 'bg-accent text-panel-alt' : 'text-muted hover:bg-edge'}"
      onclick={() => (mode = "password")}>{t("util.password.modePassword")}</button
    >
    <button
      type="button"
      data-testid="pw-mode-passphrase"
      class="px-3 py-1 text-sm {mode === 'passphrase' ? 'bg-accent text-panel-alt' : 'text-muted hover:bg-edge'}"
      onclick={() => (mode = "passphrase")}>{t("util.password.modePassphrase")}</button
    >
  </div>

  <!-- Result -->
  <div class="rounded border border-edge bg-panel p-2">
    <div class="flex items-center gap-2">
      <code
        data-testid="pw-output"
        class="min-h-[1.5rem] flex-1 break-all font-mono text-sm text-white">{value}</code
      >
      <button
        type="button"
        data-testid="pw-regenerate"
        class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-white"
        aria-label={t("util.password.regenerate")}
        onclick={() => (seed += 1)}><Icon name="refresh" size={14} /></button
      >
      <CopyButton text={value} testid="pw-copy" />
    </div>
    {#if mode === "password" && !result.ok}
      <p class="mt-1 text-[11px] text-danger" data-testid="pw-error">{t(ERR[result.error])}</p>
    {:else}
      <div class="mt-2 flex items-center gap-2">
        <div class="h-1.5 flex-1 overflow-hidden rounded bg-edge">
          <div class="h-full {strength.cls}" style="width: {strength.pct}%"></div>
        </div>
        <span class="whitespace-nowrap text-[11px]" data-testid="pw-strength">{t(strength.key)}</span>
        <span class="whitespace-nowrap text-[11px] text-muted">{t("util.password.entropy", { bits })}</span>
      </div>
    {/if}
  </div>

  {#if mode === "password"}
    <label class="block">
      {t("util.password.length")}: <span class="text-white">{opts.length}</span>
      <input type="range" min="4" max="128" class="mt-1 w-full accent-accent" bind:value={opts.length} data-testid="pw-length" />
    </label>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.lower} data-testid="pw-lower" />{t("util.password.lower")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.upper} data-testid="pw-upper" />{t("util.password.upper")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.digits} data-testid="pw-digits" />{t("util.password.digits")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.symbols} data-testid="pw-symbols" />{t("util.password.symbols")}</label>
    </div>
    <div class="space-y-1">
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.excludeAmbiguous} />{t("util.password.excludeAmbiguous")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.requireEach} />{t("util.password.requireEach")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={opts.noRepeats} />{t("util.password.noRepeats")}</label>
    </div>
    <label class="block">
      {t("util.password.exclude")}
      <input
        class="mt-1 w-full max-w-xs rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
        placeholder={"`'\";"}
        bind:value={opts.exclude}
      />
    </label>
  {:else}
    <label class="block">
      {t("util.password.words")}: <span class="text-white">{phraseOpts.words}</span>
      <input type="range" min="3" max="10" class="mt-1 w-full accent-accent" bind:value={phraseOpts.words} data-testid="pw-words" />
    </label>
    <label class="block">
      {t("util.password.separator")}
      <input
        class="mt-1 w-20 rounded border border-edge bg-panel px-2 py-1 text-center font-mono text-sm text-white outline-none focus:border-accent"
        maxlength="3"
        bind:value={phraseOpts.separator}
      />
    </label>
    <div class="space-y-1">
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={phraseOpts.capitalize} />{t("util.password.capitalize")}</label>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={phraseOpts.includeNumber} />{t("util.password.includeNumber")}</label>
    </div>
  {/if}
</div>
