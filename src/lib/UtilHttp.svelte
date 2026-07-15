<script lang="ts">
  // Utilities → HTTP client (Phase 34). A Postman-lite: method, URL, headers
  // (one "Name: Value" per line), optional body — issued from the session host
  // via curl, with status/headers/body and timing metrics parsed out. Building/
  // parsing is pure logic in http.ts.
  import CopyButton from "./CopyButton.svelte";
  import UtilProbeRunner from "./UtilProbeRunner.svelte";
  import { t } from "./i18n";
  import {
    httpArgs,
    parseHttp,
    statusClass,
    HTTP_METHODS,
    type HttpMethod,
    type HttpHeader,
  } from "./http";
  import type { ProbeSession } from "./probe";
  import type { ProbeOutput } from "./api";

  let { session }: { session: ProbeSession | null } = $props();

  let method = $state<HttpMethod>("GET");
  let url = $state("");
  let headersText = $state("");
  let body = $state("");
  let followRedirects = $state(true);

  // "Name: Value" per line → HttpHeader[] (blank/invalid lines ignored).
  const headers = $derived<HttpHeader[]>(
    headersText
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return colon > 0
          ? { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }
          : null;
      })
      .filter((h): h is HttpHeader => h !== null && h.name !== ""),
  );

  const validUrl = $derived(/^https?:\/\/\S+/i.test(url.trim()));
  const args = $derived(
    validUrl ? httpArgs({ method, url, headers, body, followRedirects }) : null,
  );

  const STATUS_CLASS: Record<ReturnType<typeof statusClass>, string> = {
    success: "bg-accent/20 text-accent",
    redirect: "bg-warn/20 text-warn",
    clientError: "bg-danger/15 text-danger",
    serverError: "bg-danger/20 text-danger",
    unknown: "bg-edge text-muted",
  };
</script>

<UtilProbeRunner {session} {args} timeoutSecs={25}>
  {#snippet form()}
    <div class="flex items-end gap-2">
      <label class="block">
        {t("util.http.method")}
        <select
          data-testid="http-method"
          class="mt-1 rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
          bind:value={method}
        >
          {#each HTTP_METHODS as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </label>
      <label class="block flex-1">
        {t("util.http.url")}
        <input
          data-testid="http-url"
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
          placeholder="https://api.example.com/health"
          bind:value={url}
        />
      </label>
    </div>
    <label class="block">
      {t("util.http.headers")}
      <textarea
        data-testid="http-headers"
        rows="2"
        class="mt-1 w-full resize-y rounded border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-white outline-none focus:border-accent"
        placeholder="Authorization: Bearer …&#10;Accept: application/json"
        bind:value={headersText}
      ></textarea>
    </label>
    <label class="block">
      {t("util.http.body")}
      <textarea
        data-testid="http-body"
        rows="2"
        class="mt-1 w-full resize-y rounded border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-white outline-none focus:border-accent"
        placeholder={`{"key":"value"}`}
        bind:value={body}
      ></textarea>
    </label>
    <label class="flex items-center gap-2 text-[11px]">
      <input type="checkbox" data-testid="http-follow" bind:checked={followRedirects} />
      {t("util.http.follow")}
    </label>
  {/snippet}

  {#snippet result(out: ProbeOutput)}
    {@const resp = parseHttp(out.stdout)}
    {#if resp}
      <div class="space-y-2" data-testid="http-response">
        <div class="flex flex-wrap items-center gap-3">
          <span class="rounded px-2 py-0.5 text-[11px] {STATUS_CLASS[statusClass(resp.status)]}" data-testid="http-status">
            {resp.status} {resp.statusText}
          </span>
          {#if resp.timings}
            <span class="text-[11px] text-muted">{t("util.http.time")}: <span class="font-mono text-white">{resp.timings.totalMs} ms</span></span>
            <span class="text-[11px] text-muted">{t("util.http.size")}: <span class="font-mono text-white">{resp.timings.sizeBytes} B</span></span>
            <span class="text-[11px] text-muted">TTFB: <span class="font-mono text-white">{resp.timings.ttfbMs} ms</span></span>
          {/if}
        </div>
        {#if resp.headers.length}
          <details class="rounded border border-edge/50 bg-panel">
            <summary class="cursor-pointer px-2 py-1 text-[11px] text-muted">{t("util.http.headers")} ({resp.headers.length})</summary>
            <table class="w-full px-2 pb-2">
              <tbody>
                {#each resp.headers as h, i (i)}
                  <tr class="align-top">
                    <td class="py-0.5 pr-3 font-mono text-[11px] text-accent">{h.name}</td>
                    <td class="py-0.5 font-mono text-[11px] break-all text-white">{h.value}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </details>
        {/if}
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-muted">{t("util.http.body")}</span>
          <CopyButton text={resp.body} />
        </div>
        <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-edge bg-panel p-2 font-mono text-[11px] text-white" data-testid="http-body-out">{resp.body}</pre>
      </div>
    {:else}
      <pre class="whitespace-pre-wrap rounded border border-danger/40 bg-danger/10 p-2 font-mono text-[11px] text-danger" data-testid="http-raw">{out.stderr || out.stdout || t("util.probe.noOutput")}</pre>
    {/if}
  {/snippet}
</UtilProbeRunner>
