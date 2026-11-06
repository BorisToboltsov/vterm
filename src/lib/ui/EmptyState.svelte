<script lang="ts">
  // Friendly empty/onboarding state: an icon, a title, an optional hint, and an
  // optional slot for call-to-action buttons. Presentational — reused for the
  // empty server list, the no-session terminal area, the docks' panels.
  //
  // It fits the room it is given (`emptytier.ts`, `use:emptyFit`): the badge, the
  // gaps and the padding shrink together by one number — the circle gets smaller
  // and two lines grow out of it to its sides, until it is a medallion in a line of
  // its own; short of that, the icon moves into the title's row and the actions
  // beside it (`line`); then only that row is left (`title`). The tier is
  // `data-tier` on the root and everything below reads it through
  // `group-data-[tier=…]`; the sizes are the root's `--empty-*` properties. The
  // root clips: whatever does not fit even the tightest layout stays inside it,
  // and `my-auto` centres the content only while there is room — short of it, the
  // content starts at the top instead of climbing over what is above.
  import type { Snippet } from "svelte";
  import { EMPTY_STYLE, emptyFit } from "../actions/emptyfit";
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
  data-tier="badge"
  class="group/empty relative flex h-full min-h-0 flex-col items-center overflow-hidden px-(--empty-pad-x) py-(--empty-pad-y) text-center"
  style={EMPTY_STYLE}
  use:emptyFit={[title, hint]}
>
  <div class="my-auto flex w-full flex-col items-center gap-(--empty-gap)">
    <!-- The badge: a circle between two lines that grow out of it as it shrinks.
         Never a flex item that may shrink — that is what made it an oval; its size
         is the fit's, one for both sides. -->
    <div
      data-testid="empty-state-badge"
      data-empty-badge
      class="hidden w-full max-w-sm shrink-0 items-center gap-2 group-data-[tier=badge]/empty:flex"
    >
      <span
        class="h-px flex-1 origin-right scale-x-(--empty-lines) bg-linear-to-r from-transparent to-edge opacity-(--empty-lines)"
      ></span>
      <span
        data-empty-icon="badge"
        class="flex size-(--empty-badge) shrink-0 items-center justify-center rounded-full border border-edge bg-panel-alt text-muted"
      >
        <span data-empty-glyph class="inline-flex scale-(--empty-glyph)"><Icon name={icon} size={26} /></span>
      </span>
      <span
        class="h-px flex-1 origin-left scale-x-(--empty-lines) bg-linear-to-l from-transparent to-edge opacity-(--empty-lines)"
      ></span>
    </div>
    <!-- Title, hint and actions in one wrapping row, so the tight layouts can put
         the actions beside the title. The hint always takes a line of its own
         (`basis-full`), the actions do while there is room: between title and
         actions, then under the two of them (`order-last`). -->
    <div class="flex max-w-full flex-wrap items-center justify-center gap-x-2">
      <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text">
        <span
          data-empty-icon="line"
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
            class="mx-auto max-w-xs text-xs leading-relaxed text-muted group-data-clamp/empty:line-clamp-2 group-data-[tier=line]/empty:line-clamp-2"
          >
            {hint}
          </p>
        </div>
      {/if}
      {#if children}
        <div
          data-empty-actions
          class="flex basis-full flex-wrap items-center justify-center gap-2 pt-(--empty-cta) group-data-[tier=line]/empty:basis-auto group-data-[tier=title]/empty:basis-auto"
        >
          {@render children()}
        </div>
      {/if}
    </div>
  </div>
</div>
