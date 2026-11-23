<script lang="ts">
  // A table's structure (ADR 0081): its columns, its indexes with their size,
  // its foreign keys both ways — each a way to the table at its other end —
  // and its size and upkeep. What this server does not keep is a dash, not a
  // guess (INVARIANTS principle 5).
  import { compactAge } from "../ui/age";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import { deadShare, rowsText, sizeText, type StructFk, type TableRef, type TableStructure } from "./dbtable";

  let {
    structure,
    loading,
    error,
    onopen,
  }: {
    structure: TableStructure | null;
    loading: boolean;
    error: string | null;
    /** Open the table at a key's other end. */
    onopen: (table: TableRef) => void;
  } = $props();

  const ago = (s: number | null) => (s === null ? "—" : compactAge(0, s * 1000));
  const keyOf = (name: string, s: TableStructure) =>
    s.indexes.some((i) => i.primary && i.columns.includes(name)) ? "pk" : s.foreign.some((f) => f.columns.includes(name)) ? "fk" : null;
  const fkLine = (k: StructFk, incoming: boolean) =>
    incoming ? `${k.from.name}.${k.columns.join(", ")} → ${k.refColumns.join(", ")}` : `${k.columns.join(", ")} → ${k.ref.name}.${k.refColumns.join(", ")}`;
  const sec = "mb-1 mt-3 text-caption uppercase tracking-wider text-muted first:mt-0";
</script>

<div class="@container h-full min-h-0 overflow-auto p-3 text-xs" data-testid="db-structure">
  {#if loading && !structure}
    <p class="flex items-center gap-2 text-muted"><Icon name="loader" size={13} class="animate-spin" />{t("db.table.structureReading")}</p>
  {:else if error && !structure}
    <p class="text-bad">{error}</p>
  {:else if structure}
    <p class={sec}>{t("db.struct.columns")}</p>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse font-mono text-meta">
        <thead>
          <tr class="border-b border-edge text-left text-muted">
            <th class="w-8 py-1 pr-2 font-normal">#</th>
            <th class="py-1 pr-3 font-normal">{t("db.struct.name")}</th>
            <th class="py-1 pr-3 font-normal">{t("db.struct.type")}</th>
            <th class="py-1 pr-3 font-normal">{t("db.struct.null")}</th>
            <th class="py-1 pr-3 font-normal">{t("db.struct.default")}</th>
            <th class="py-1 font-normal">{t("db.struct.key")}</th>
          </tr>
        </thead>
        <tbody>
          {#each structure.columns as c, i (c.name)}
            {@const key = keyOf(c.name, structure)}
            {@const fk = structure.foreign.find((f) => f.columns.includes(c.name))}
            <tr class="border-b border-edge/40 align-top">
              <td class="py-0.5 pr-2 text-caption text-muted">{i + 1}</td>
              <td class="py-0.5 pr-3 text-text">{c.name}{#if c.comment}<span class="ml-2 font-sans text-muted">{c.comment}</span>{/if}</td>
              <td class="py-0.5 pr-3 text-muted">{c.type}</td>
              <td class="py-0.5 pr-3 {c.nullable ? 'text-text' : 'text-muted'}">{c.nullable ? t("db.struct.yes") : "—"}</td>
              <td class="break-all py-0.5 pr-3 text-muted">
                {#if c.identity}{c.identity === "always" ? t("db.struct.identityAlways") : t("db.struct.identityDefault")}
                {:else if c.generated}{t("db.struct.generated", { expr: c.default ?? "" })}
                {:else}{c.default ?? ""}{#if c.extra}<span class="ml-1">{c.extra}</span>{/if}{/if}
              </td>
              <td class="whitespace-nowrap py-0.5">
                {#if key === "pk"}<span class="text-warn">PK</span>{/if}
                {#if fk}<button type="button" class="ml-1 text-accent hover:underline" onclick={() => onopen(fk.ref)}>FK → {fk.ref.name}</button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="mt-1 grid gap-x-6 @[40rem]:grid-cols-2">
      <div>
        <p class={sec}>{t("db.struct.indexes")}</p>
        {#each structure.indexes as ix (ix.name)}
          <p class="font-mono text-meta leading-5">
            <span class="text-text">{ix.name}</span>
            <span class="text-muted">{[ix.columns, ix.primary ? "PK" : ix.unique ? t("db.struct.unique") : null, sizeText(ix.bytes)].filter((x) => x !== null).join(" · ")}</span>
          </p>
        {:else}
          <p class="text-meta text-muted">{t("db.struct.noIndexes")}</p>
        {/each}

        {#if structure.size}
          {@const s = structure.size}
          {@const dead = deadShare(s)}
          <p class={sec}>{t("db.struct.size")}</p>
          <p class="text-meta leading-5 text-text" data-testid="db-struct-size">
            {[
              t("db.struct.data", { size: sizeText(s.data) }),
              t("db.struct.indexesSize", { size: sizeText(s.indexes) }),
              s.toast !== null ? `TOAST ${sizeText(s.toast)}` : null,
              t("db.struct.total", { size: sizeText(s.total) }),
            ]
              .filter((x) => x !== null)
              .join(" · ")}
          </p>
          <p class="text-meta leading-5 text-muted" data-testid="db-struct-upkeep">
            {[
              s.estimate !== null ? t("db.struct.estimate", { n: rowsText(s.estimate) }) : null,
              t("db.struct.dead", { pct: dead === null ? "—" : `${dead} %` }),
              `ANALYZE ${ago(s.analyzedAgo)}`,
              `VACUUM ${ago(s.vacuumedAgo)}`,
              s.engine !== null ? t("db.struct.engine", { name: s.engine }) : null,
              s.free !== null ? t("db.struct.free", { size: sizeText(s.free) }) : null,
            ]
              .filter((x) => x !== null)
              .join(" · ")}
          </p>
        {/if}
      </div>
      <div>
        <p class={sec}>{t("db.struct.foreign")}</p>
        {#each structure.foreign as k (k.name)}
          <button type="button" class="block w-full truncate text-left font-mono text-meta leading-5 hover:underline" onclick={() => onopen(k.ref)} data-testid="db-struct-fk">
            <span class="text-accent">{fkLine(k, false)}</span>{#if k.onDelete}<span class="ml-1 text-muted">ON DELETE {k.onDelete}</span>{/if}
          </button>
        {:else}
          <p class="text-meta text-muted">{t("db.struct.none")}</p>
        {/each}
        <p class={sec}>{t("db.struct.incoming")}</p>
        {#each structure.incoming as k (`${k.from.schema}.${k.from.name}.${k.name}`)}
          <button type="button" class="block w-full truncate text-left font-mono text-meta leading-5 hover:underline" onclick={() => onopen(k.from)} data-testid="db-struct-incoming">
            <span class="text-accent">{fkLine(k, true)}</span>{#if k.onDelete}<span class="ml-1 text-muted">ON DELETE {k.onDelete}</span>{/if}
          </button>
        {:else}
          <p class="text-meta text-muted">{t("db.struct.none")}</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
