# Recipes

Practical, copy-pasteable patterns for `figma_write`. Each recipe assumes you're calling the MCP tool `figma_write({ code, sessionId })`; the `code` blocks below are the value of that `code` field.

- [Mobile screen frame with auto-layout](#mobile-screen-frame-with-auto-layout)
- [Modal with overlay](#modal-with-overlay)
- [Text that wraps](#text-that-wraps)
- [State variants for a button](#state-variants-for-a-button)
- [Batch-drawing a list](#batch-drawing-a-list)
- [Design tokens from a design.md-style palette](#design-tokens-from-a-designmd-style-palette)
- [Verify-and-fix loop with layout_audit](#verify-and-fix-loop-with-layout_audit)
- [Icon search + insert](#icon-search--insert)

---

## Mobile screen frame with auto-layout

A common starting point: a 390×844 screen frame with a vertical auto-layout stack, safe padding, and a fixed-width body so children can wrap correctly.

```js
const screen = await figma.create({
  type: "FRAME",
  name: "Screen / Home",
  width: 390,
  height: 844,
  layoutMode: "VERTICAL",
  primaryAxisSizingMode: "FIXED",
  counterAxisSizingMode: "FIXED",
  paddingTop: 24, paddingBottom: 24, paddingLeft: 16, paddingRight: 16,
  itemSpacing: 12,
  fills: [{ type: "SOLID", color: "#FFFFFF" }],
});
state.rootId = screen.id; // reuse in later calls this session

const header = await figma.create({
  type: "TEXT", parentId: screen.id, wrap: true,
  characters: "Good morning", layoutAlign: "STRETCH",
});
```

Because the parent is a fixed-size auto-layout frame, a child auto-layout frame under it defaults to `counterAxisSizingMode: "FIXED"` on the constrained axis — you don't need to set it explicitly to avoid overflow, only to opt out of it.

---

## Modal with overlay

Never build a scrim with an opacity'd `FRAME` — it dims its entire subtree, including any content you later add on top. Use `figma.overlay()`, which creates a plain `RECTANGLE` sized to the parent at the correct layer:

```js
const scrim = await figma.overlay({
  parentId: state.rootId,
  color: "#000000",
  opacity: 0.5,
  insertAt: "top",
});

const modal = await figma.create({
  type: "FRAME", name: "Modal", parentId: state.rootId,
  width: 320, align: "center", insertAt: "top",
  layoutMode: "VERTICAL", paddingTop: 24, paddingBottom: 24, paddingLeft: 20, paddingRight: 20,
  fills: [{ type: "SOLID", color: "#FFFFFF" }], cornerRadius: 16,
});
await figma.create({ type: "TEXT", parentId: modal.id, wrap: true, characters: "Delete this item?" });
```

Note `insertAt: "top"` on both — the scrim and the modal need to sit above existing screen content, and the modal needs to sit above the scrim (draw the scrim first, then the modal, both pinned to `"top"`).

---

## Text that wraps

Wrapping requires a parent with a fixed width to wrap against — `wrap: true` on its own won't do anything useful without one.

```js
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, layoutMode: "VERTICAL",
});

await figma.create({
  type: "TEXT", parentId: card.id, wrap: true,
  characters: "A long paragraph of body copy that needs to wrap across multiple lines inside the card.",
});
```

`wrap: true` sets `layoutAlign: "STRETCH"`, `textAutoResize: "HEIGHT"`, and a sane default `lineHeight` (~1.45× font size) for you. If `card` didn't have a fixed `width`, the response would carry a warning that there's nothing to wrap against — read `warnings` and fix the parent, don't ignore it.

---

## Draw once, reuse everywhere (componentize)

Drew a card, then copied it around while iterating? Turn the original into a component and let every structural copy become an instance in one call:

```js
const r = await figma.componentize(state.cardId, { name: "Card/Base" });
// r.componentId — the new COMPONENT (converted in place)
// r.replacedCount / r.replaced — every same-structure copy on the page,
// now instances at the same position. scope: "document" widens the sweep;
// replaceCopies: false only converts.
```

From here on, edits to the component propagate; per-copy tweaks go through `instantiate` props/overrides or `setInstanceOverrides`.

## State variants for a button

Use `createVariants` to get a real Figma component set (not a flat pile of look-alike frames), then instantiate the variant you need:

```js
const button = await figma.createVariants(
  { type: "COMPONENT", name: "Button/Primary", width: 120, height: 44, layoutMode: "HORIZONTAL" },
  [
    { name: "State=Default", fills: [{ type: "SOLID", color: { r: 0.15, g: 0.39, b: 0.92 } }] },
    { name: "State=Pressed", fills: [{ type: "SOLID", color: { r: 0.10, g: 0.29, b: 0.75 } }] },
    { name: "State=Disabled", fills: [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }] },
  ],
);
```

For a multi-axis matrix (Size × State × …), pass axes instead of a list — each combination becomes one variant and Figma derives the property definitions from the names:

```js
const button = await figma.createVariants(
  { type: "COMPONENT", name: "Button", width: 120, height: 44, layoutMode: "HORIZONTAL" },
  { Size: ["sm", "md", "lg"], State: ["default", "hover", "disabled"] },
); // → 9 variants: "Size=sm, State=default", … (max 50 combos)
// Style each variant afterwards via figma.batch([{op:"modify", …}]) using button.variants[i].id.

const instance = await figma.instantiate(button.id, {
  parentId: state.rootId,
  overrides: { Label: "Continue" },
});
```

Prefer `figma.findOrCreateComponent("Button/Primary", spec)` first if a matching component might already exist in the file — reuse before create. It returns `decision: "reuse"|"create"` + `score` + `reason`; pass `{ dryRun: true }` as the third argument to see the decision (and candidates) without creating anything.

`instantiate` also accepts a name query directly — `figma.instantiate("Button/Primary", { parentId })` — so an exact-name instantiation needs no separate `findComponent` step; an ambiguous name errors with ranked candidates instead of guessing.

---

## Batch-drawing a list

For many similar nodes (e.g. rendering rows from data), use `figma.batch()` instead of N separate round-trips. It streams in chunks of 20, commits successes even if some items fail, and reports exactly which index failed:

```js
const rows = [{ label: "Alice" }, { label: "Bob" }, { label: "Carol" } /* ...more */];

const ops = rows.map((r) => ({
  op: "create",
  params: { type: "TEXT", parentId: state.listId, characters: r.label, wrap: true },
}));

const res = await figma.batch(ops);
console.log(`${res.ok}/${res.total} rows drawn`);
res.results.forEach((r) => {
  if (!r.ok) console.error(`row ${r.index} (${rows[r.index].label}) failed:`, r.error?.message);
});
```

There's no hard cap — this same code works whether `rows` has 5 items or 500.

---

## Setting up design tokens from a design.md-style palette

If your project keeps a `design.md` (or similar) with a color/spacing palette, translate it into one `setupTokens` call at the start of the session — it's idempotent, so re-running the same call later (e.g. at the top of a new `figma_write` invocation, just to be safe) won't create duplicates:

```js
await figma.setupTokens({
  colors: {
    primary:      "#2563EB",
    surface:      { light: "#FFFFFF", dark: "#0B0B0F" },
    "on-surface": { light: "#0B0B0F", dark: "#F5F5F7" },
    danger:       "#DC2626",
  },
  numbers: {
    "radius-sm": 4,
    "radius-md": 8,
    "radius-lg": 16,
    "space-2": 8,
    "space-4": 16,
    "space-6": 24,
  },
  strings: {
    "font-body": "Inter",
    "font-heading": "Inter",
  },
});
```

Then apply tokens by name instead of hardcoding values:

```js
await figma.applyVariable(card.id, "fills", "surface");
await figma.applyVariable(card.id, "cornerRadius", "radius-md");
```

The session token map is available at `state.tokens` (name → value) after `setupTokens`, so prefer `applyVariable` over re-writing a hex you already tokenized — a single token edit then re-themes everything.

---

## Verify-and-fix loop with layout_audit

Draw, then verify with data, then only screenshot for a human once the audit is clean:

```js
const card = await figma.create({ type: "FRAME", name: "Card", width: 320, height: 200, layoutMode: "VERTICAL" });
await figma.create({ type: "TEXT", parentId: card.id, wrap: true, characters: "A long paragraph that must wrap…" });

let audit = await figma.layoutAudit(card.id);

if (audit.summary.issues.length) {
  console.warn("layout issues:", audit.summary.issues);
  // Example fix: a child overflowed because the parent had no fixed height —
  // resize the parent and re-audit.
  await figma.resize(card.id, { w: 320, h: 260 });
  audit = await figma.layoutAudit(card.id);
}

if (!audit.summary.issues.length) {
  const png = await figma.screenshot({ nodeId: card.id, scale: 0.6 }); // for the human, not for self-verification
}
```

Treat `audit.summary.issues` as the pass/fail gate. Don't skip straight to a screenshot and eyeball it — `overflowsParent`/`clippedBy`/`textTruncated` are structural facts the audit already computed for you.

---

## Icon search + insert

Search first (cheap — no fetch), pick a candidate, then load it:

```js
const candidates = await figma.searchIcons("visibility");
// → [{ name: "eye", alias: "visibility", libraries: ["lucide", "ionicons", "tabler", "bootstrap-icons"] }, ...]

await figma.loadIcon("visibility", {
  library: "lucide",
  size: 24,
  color: "#F5F5F7",
  parentId: button.id,
});
```

If a specific library doesn't have the icon, `loadIcon` throws `NODE_NOT_FOUND` — try `searchIcons` again or pass a different `library` from the candidate's `libraries` list. Fetched SVGs are cached on disk (`$TMPDIR/reqwise-figma-mcp/cache/`), so repeated inserts of the same icon in later calls don't re-fetch.
