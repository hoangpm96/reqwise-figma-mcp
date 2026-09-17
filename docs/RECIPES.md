# Recipes

Practical, copy-pasteable patterns for `figma_write`. Each recipe assumes you're calling the MCP tool `figma_write({ code, sessionId })`; the `code` blocks below are the value of that `code` field.

- [The two-file design-system workflow](#the-two-file-design-system-workflow) ← read this first
- [Map the userflow before drawing the screens](#map-the-userflow-before-drawing-the-screens)
- [Act on a diagram finding without re-authoring the diagram](#act-on-a-diagram-finding-without-re-authoring-the-diagram)
- [Mobile screen frame with auto-layout](#mobile-screen-frame-with-auto-layout)
- [Modal with overlay](#modal-with-overlay)
- [Text that wraps](#text-that-wraps)
- [State variants for a button](#state-variants-for-a-button)
- [Batch-drawing a list](#batch-drawing-a-list)
- [Setting up design tokens from a design.md-style palette](#setting-up-design-tokens-from-a-designmd-style-palette)
- [Verify-and-fix loop with layout_audit](#verify-and-fix-loop-with-layout_audit)
- [Icon search + insert](#icon-search--insert)

---

## The two-file design-system workflow

The single most important convention in this project. Two files, **never** merged, related like `package.json` ↔ `package-lock.json`:

| File | Authored by | Read it when | Overwritten? |
|---|---|---|---|
| `design.md` | **You** (human intent — palette, type ramp, brand voice, which components should exist) | **Building** the design system | Never. The tools do not touch it. |
| `design-kit.md` | **The tool** (`generate_design_md` — a snapshot of what actually exists in Figma) | **Drawing** screens | Freely. Regenerate any time; never hand-edit. |

The flow runs one direction at a time and always ends in a regenerate:

```
design.md (or an interview)  →  build the DS in Figma  →  generateDesignMd()  →  design-kit.md
                                        ▲                                             │
                                 Figma is the truth                    read this when drawing
```

**Building** (once): set up tokens, text styles and components, then snapshot.

```js
await figma.setupTokens({
  colors:  { "color/primary": "#5865f2", "color/ink": "#0F172A" },
  numbers: { "space/md": 16, "radius/sm": 12 },
});
await figma.setupTextStyles([
  { name: "display-xl", fontSize: 82, weight: 800, fontFamily: "Space Grotesk" },
  { name: "body",       fontSize: 16, weight: 400, fontFamily: "Inter" },
]);

const kit = await figma.generateDesignMd({ depth: 3, includeAnatomy: true, includeScreens: true });
return kit.markdown; // save as design-kit.md — its header carries <!-- dsfp:HASH -->
```

> Building edits the Figma file and is expensive. If a `design.md` already exists and the file has no design system yet, **ask the user before building from it.**

**Drawing** (every session): check the fingerprint first, then draw by *name*.

```js
const live = await figma.designFingerprint();  // { hash, counts } — cheap
// Compare live.hash to the dsfp: in design-kit.md's header (read from the repo).
// Match    → trust the cached file; a screen build costs one file read.
// Mismatch → someone changed the DS in Figma without regenerating. Regenerate first.

await figma.create({ type: "FRAME", parentId: page.id, fill: "$color/canvas",
                     tokens: { padding: "space/section" } });
await figma.create({ type: "TEXT", parentId: page.id, text: "Hi",
                     textStyle: "display-xl", fill: "$color/ink" });
```

Two rules that make this safe:

- **Consume by name, never by id.** Token and component names are the stable API; node ids change between sessions. That's why `design-kit.md` deliberately drives via names + a fingerprint rather than ids.
- **Names resolve live at draw time**, so a slightly stale kit file fails *loudly* (name miss + ranked candidates) instead of silently binding the wrong token.

Recolouring an existing token does **not** change the hash; adding, removing or renaming one does.

The agent-facing version of this convention lives in `figma_docs({ section: "rules" })`.

---

## Map the userflow before drawing the screens

A flow agreed in one call is cheaper than eight artboards redrawn after the user
says "you missed the expired-link case". Ask first — *"map the userflow first,
then draw the UI?"* — then derive the graph yourself from the spec/PRD and let
the tool draw and proof-read it.

```js
// 1. Check the shape of the graph before anything is drawn.
const check = await figma.userflow({
  title: "Checkout",
  options: { dryRun: true },
  nodes: [
    { id: "cart", label: "Cart",         kind: "screen",   screenId: "2.1", slug: "cart" },
    { id: "pay",  label: "Payment ok?",  kind: "decision" },
    { id: "done", label: "Order placed", kind: "terminal" },
    { id: "err",  label: "E-402 · declined", kind: "state", cls: "error" },
  ],
  edges: [
    { from: "cart", to: "pay",  label: "Pay" },
    { from: "pay",  to: "done", label: "yes" },
    { from: "pay",  to: "err",  label: "no" },
    { from: "err",  to: "cart", label: "Try another card", kind: "return" },
  ],
});
// check.warnings names what is missing: a question with one answer, a branch
// with no label, a dead end, a screen nothing leads to, a flow with no entry.

// 2. Draw it, then the screens — artboards named after their screenId.
const flow = await figma.userflow({ title: "Checkout", x: 80, y: 200, nodes, edges,
  options: { linkScreens: true } });

await figma.create({
  type: "FRAME", name: "2.1 · cart",
  x: 80, y: 200 + flow.stats.h + 120, width: 390, height: 844, fill: "#ffffff",
});
```

`flow.nodes` maps each graph id to the Figma node drawn for it, so you can keep
annotating individual boxes without hunting for them by name.

Two habits make the flow stay true after the first pass:

- **Name artboards after the screenId** (`"2.1 · cart"`), as a whole token —
  `options.linkScreens` then wires ON_CLICK → NAVIGATE from each box to its
  artboard, and reports (never guesses) the ids it could not find.
- **Listen to the create warnings.** Drawing a page-level screen tells you
  whether the page has no userflow at all, or has one that does not contain the
  screen you just drew. Both are questions for the user, not decisions for you.

Rearranging the drawn flow by hand is fine: while the plugin is open, dragging
or resizing a box re-routes every arrow touching it, and deleting a box hides
the arrows that pointed at it. After a rearrange with the plugin closed,
`await figma.reflowDiagram()` puts the arrows back.

Mermaid already written? Pass it as `mermaid` instead of `nodes`/`edges`. Labels
in Japanese or Korean? Pass `options.font` — Inter has no glyphs for them and
Figma renders the text blank. Full reference: `figma_docs(section="userflow")`
and [`TOOLS.md`](./TOOLS.md#type-userflow--the-screens-a-user-moves-through).

## Act on a diagram finding without re-authoring the diagram

`figma_diagram` returns `warnings` about the **model** — that is the deliverable, not a nuisance. The naive fix is to re-send the whole spec with one string changed. Don't: the frame already stores the model it was drawn from, so a finding costs one op.

```jsonc
// 1. Draw. `warnings` comes back with the frame.
{ "type": "state", "title": "Vòng đời vé", "text": "…",
  "options": { "policies": { "hold-minutes": 10 } } }
// → { frameId: "140:5914",
//     warnings: ["state `held` has no way out — nothing can leave it"],
//     consistency: [] }
```

```jsonc
// 2. Read what is actually stored, so the patch selects something real.
{ "op": "get_diagram_spec", "params": { "nodeId": "140:5914" } }
```

```jsonc
// 3. Patch the model. No `type`, no `title`, none of the spec — the frame is the source.
{ "update": "140:5914",
  "patch": [
    { "collection": "states", "add": { "id": "expired", "label": "Hết hạn", "kind": "final" } },
    { "collection": "transitions",
      "add": { "from": "held", "to": "expired", "event": "Timeout", "guard": "sau @hold-minutes phút" } }
  ] }
// → redrawn in place: same frameId, same position, `patched` lists both ops.
```

The frame keeps its id, so comments on it and prototype links into it survive — and the checker runs on the patched model exactly as it would on a fresh one, so a patch cannot smuggle a broken diagram past proof-reading.

Three habits that follow from this:

- **`@rule` instead of a number.** `"sau @hold-minutes phút"` above draws as `sau 10 phút`. Change the rule with `{ "set": { "options.policies.hold-minutes": 15 } }` and every label that references it moves; a label that holds no number cannot drift from one.
- **`null` deletes.** `{ "collection": "states", "id": "expired", "set": { "kind": null } }` is how a state stops being `final` — JSON has no way to say `undefined`.
- **Read the page before you draw.** `figma_read` op `get_page_model` with `{ "scope": "file" }` says what already exists across the whole file — worth exactly one call at the start of a session, and it is what makes `consistency` findings meaningful.

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


Drew a card, then copied it around while iterating? Turn the original into a component and let every structural copy become an instance in one call:

```js
// r.componentId — the new COMPONENT (converted in place)
// r.replacedCount / r.replaced — every same-structure copy on the page,
// now instances at the same position. scope: "document" widens the sweep;
// replaceCopies: false only converts.
```


## State variants for a button


```js
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
  { type: "COMPONENT", name: "Button", width: 120, height: 44, layoutMode: "HORIZONTAL" },
  { Size: ["sm", "md", "lg"], State: ["default", "hover", "disabled"] },
); // → 9 variants: "Size=sm, State=default", … (max 50 combos)
// Style each variant afterwards via figma.batch([{op:"modify", …}]) using button.variants[i].id.

  parentId: state.rootId,
  overrides: { Label: "Continue" },
});
```



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
