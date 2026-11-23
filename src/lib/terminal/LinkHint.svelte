<script lang="ts">
  // The hint a plain click on a link in terminal output shows (v1.36,
  // `stores/linkhint`): one line at the click, as in PyCharm — what opening it
  // does, and that ⌘-click (Ctrl-click off macOS) does it at once. Its button is
  // that ⌘-click. Nothing opens without it: a click into the terminal to focus
  // it or to place a selection lands on a name all the time.
  //
  // The hint goes with Esc (which then goes no further — not to the shell), any
  // other key, a press anywhere else, the wheel, the window losing focus or
  // changing size, and the pointer wandering off. One per window, mounted by the
  // page; it also tells the store whether the modifier is held.
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import { t } from "../i18n";
  import { hostEnv } from "../stores/hostenv.svelte";
  import { currentLinkHint, dismissLinkHint, followLinkHint, setModifierHeld } from "../stores/linkhint.svelte";
  import { hintPlace, pointerLeft, type LinkHintKind } from "./linkgate";

  const hint = $derived(currentLinkHint());
  let box: HTMLDivElement | undefined = $state();
  let w = $state(0);
  let h = $state(0);
  let viewW = $state(0);
  let viewH = $state(0);
  const place = $derived(hint ? hintPlace(hint, { w, h }, { w: viewW, h: viewH }) : null);

  const ICONS: Record<LinkHintKind, IconName> = { web: "globe", file: "file", dir: "folder", path: "arrowRight" };
  const LABELS = {
    web: "linkhint.web",
    file: "linkhint.file",
    dir: "linkhint.dir",
    path: "linkhint.path",
  } as const satisfies Record<LinkHintKind, string>;
  const key = $derived(hostEnv.os === "macos" ? "⌘" : "Ctrl");

  const modifier = (e: KeyboardEvent | PointerEvent) => (hostEnv.os === "macos" ? e.metaKey : e.ctrlKey);
  const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

  function onkeydown(e: KeyboardEvent) {
    setModifierHeld(modifier(e));
    if (!hint) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissLinkHint();
    } else if (!MODIFIER_KEYS.has(e.key)) {
      dismissLinkHint();
    }
  }

  function onpointerdown(e: PointerEvent) {
    setModifierHeld(modifier(e));
    if (hint && !box?.contains(e.target as Node)) dismissLinkHint();
  }

  function onpointermove(e: PointerEvent) {
    setModifierHeld(modifier(e));
    if (hint && !box?.contains(e.target as Node) && pointerLeft(hint, { x: e.clientX, y: e.clientY })) {
      dismissLinkHint();
    }
  }

  function onblur() {
    setModifierHeld(false);
    dismissLinkHint();
  }
</script>

<svelte:window
  bind:innerWidth={viewW}
  bind:innerHeight={viewH}
  onkeydowncapture={onkeydown}
  onkeyupcapture={(e) => setModifierHeld(modifier(e))}
  onpointerdowncapture={onpointerdown}
  {onpointermove}
  onwheelcapture={() => hint && dismissLinkHint()}
  {onblur}
  onresize={() => hint && dismissLinkHint()}
/>

{#if hint && place}
  <div
    bind:this={box}
    bind:clientWidth={w}
    bind:clientHeight={h}
    data-testid="link-hint"
    class="fixed z-[60] flex items-center gap-1.5 rounded-[7px] border border-edge bg-panel py-1 pl-1 pr-2 text-meta shadow-[0_6px_18px_rgb(0_0_0/0.45)]"
    style:left="{place.x}px"
    style:top="{place.y}px"
  >
    <button
      type="button"
      data-testid="link-hint-open"
      class="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-edge"
      onmousedown={(e) => e.preventDefault()}
      onclick={followLinkHint}
    >
      <Icon name={ICONS[hint.kind]} size={12} />
      {t(LABELS[hint.kind])}
    </button>
    <span class="rounded border border-edge px-1 text-caption text-muted">{t("linkhint.key", { key })}</span>
  </div>
{/if}
