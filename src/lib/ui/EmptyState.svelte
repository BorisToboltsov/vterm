<script lang="ts">
  // Friendly empty/onboarding state: an icon, a title, an optional hint, and an
  // optional slot for call-to-action buttons. Presentational — reused for the
  // empty server list, the no-session terminal area, the docks' panels.
  //
  // It fits the room it is given (v1.30, `emptytier.ts`): the roomiest of four
  // tiers whose layout fits its own height — the badge in a circle; a smaller
  // medallion set in a line of its own; the icon in the title's row, the actions
  // beside it; that row alone. The tier is `data-tier` on the root, set by
  // `use:emptyFit`, and everything below reads it through `group-data-[tier=…]`.
  // The root clips: whatever does not fit even the tightest tier stays inside
  // it, and `my-auto` centres the content only while there is room — short of
  // it, the content starts at the top instead of climbing over what is above.
  import type { Snippet } from "svelte";
  import { emptyFit } from "../actions/emptyfit";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";

  let {
    icon,
    title,
    hint,
    children,
  }: {
    icon: IconName;
    title: string;
    hint?: string;
    children?: Snippet;
  } = $props();
</script>

<div
  data-testid="empty-state"
  data-tier="full"
  class="group/empty relative flex h-full min-h-0 flex-col items-center overflow-hidden px-3 py-1.5 text-center data-[tier=full]:p-6 data-[tier=medal]:px-4 data-[tier=medal]:py-2 data-[tier=title]:py-0.5"
  use:emptyFit={[title, hint]}
>
  <div
    class="my-auto flex w-full flex-col items-center gap-1 group-data-[tier=full]/empty:gap-3 group-data-[tier=medal]/empty:gap-2"
  >
    <!-- full: the badge in a circle. Never a flex item that may shrink — that
         is what made it an oval. -->
    <div
      class="hidden h-14 w-14 shrink-0 items-center justify-center rounded-full border border-edge bg-panel-alt text-muted group-data-[tier=full]/empty:flex"
    >
      <Icon name={icon} size={26} />
    </div>
    <!-- medal: a smaller medallion in a break of its own line — the line is the
         empty state's, not the dock's tab strip, so it lies over nothing. -->
    <div
      data-testid="empty-state-medal"
      class="hidden w-full max-w-sm shrink-0 items-center gap-2 group-data-[tier=medal]/empty:flex"
    >
      <span class="h-px flex-1 bg-linear-to-r from-transparent to-edge"></span>
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-panel-alt text-muted"
      >
        <Icon name={icon} size={18} />
      </span>
      <span class="h-px flex-1 bg-linear-to-l from-transparent to-edge"></span>
    </div>
    <!-- Title, hint and actions in one wrapping row, so the tight tiers can put
         the actions beside the title. The hint always takes a line of its own
         (`basis-full`), the actions do while there is room: between title and
         actions, then under the two of them (`order-last`). -->
    <div class="flex max-w-full flex-wrap items-center justify-center gap-x-2">
      <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text">
        <span
          class="hidden shrink-0 text-muted group-data-[tier=line]/empty:inline-flex group-data-[tier=title]/empty:inline-flex"
        >
          <Icon name={icon} size={16} />
        </span>
        <span class="min-w-0">{title}</span>
      </p>
      {#if hint}
        <div
          class="basis-full pt-1 group-data-[tier=line]/empty:order-last group-data-[tier=line]/empty:pt-0.5 group-data-[tier=title]/empty:sr-only"
        >
          <p
            class="mx-auto max-w-xs text-xs leading-relaxed text-muted group-data-[tier=line]/empty:line-clamp-2 group-data-[tier=medal]/empty:line-clamp-2"
          >
            {hint}
          </p>
        </div>
      {/if}
      {#if children}
        <div
          class="flex basis-full flex-wrap items-center justify-center gap-2 pt-3 group-data-[tier=medal]/empty:pt-2 group-data-[tier=line]/empty:basis-auto group-data-[tier=line]/empty:pt-0 group-data-[tier=title]/empty:basis-auto group-data-[tier=title]/empty:pt-0"
        >
          {@render children()}
        </div>
      {/if}
    </div>
  </div>
</div>
