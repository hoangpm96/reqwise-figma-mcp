# Tool Reference

Reqwise Figma MCP exposes exactly 6 MCP tools. This document is the full reference for each — parameters, every `figma_read` operation, the entire `figma.*` sandbox API used by `figma_write`, error codes, warnings, batch behavior, and session state.

- [Which tool, when](#which-tool-when)
- [`figma_status`](#figma_status)
- [`figma_read`](#figma_read)
- [`figma_write`](#figma_write)
- [`figma_diagram`](#figma_diagram)
- [`figma_rules`](#figma_rules)
- [`figma_docs`](#figma_docs)
- [Error codes](#error-codes)
- [Warnings](#warnings)
- [Batch streaming](#batch-streaming)
- [Session state](#session-state)

## Which tool, when

The six tools split by *intent* — diagnose, read, write, learn:

| You want to… | Call |
|---|---|
| Check the connection, or anything behaves oddly | `figma_status` — read `hints` first; it names the next concrete step. |
| Draw **in a file that has a design system** | `figma_rules` first (one-call rule sheet), so you bind existing variables/components instead of hardcoding hexes and lookalikes. |
| Produce a **durable spec** of an existing design system (for a codebase, or before a big build) | `figma_read` op `generate_design_md` → save the markdown as **`design-kit.md`** (machine-generated; `design.md` is the human-authored intent file and is never overwritten — see the [two-file workflow](./RECIPES.md#the-two-file-design-system-workflow)). For structured JSON, `get_design_system_kit`. |
| Assemble a design system **by hand**, piece by piece | `figma_write` with `setupTokens` / `setupTextStyles` / `setupEffectStyles`, then `generate_design_md` to snapshot it. |
| Check whether a cached `design-kit.md` is still valid | `figma_write` → `designFingerprint()`, compare `hash` to the `<!-- dsfp:… -->` in the file. |
| See what's on the canvas | `figma_read`: `get_design_context` (page map — sparse by default, then drill into a `nodeId`), `read_selection` (what the user selected, deep), `search_nodes` (find by name/type/text), `get_node`/`get_nodes` (known ids). |
| Create or modify anything on the canvas | `figma_write` — one call can mix reads and writes; use `figma.batch()` for many sibling ops. |
| Map a **userflow** before (or alongside) the screens | `figma_diagram` type:`"userflow"` — you supply the graph you derived from the spec; it lays it out, draws it, and reports the holes in it. Ask the user whether to do this *before* drawing screens. |
| Draw an **exchange between systems** over time | `figma_diagram` type:`"sequence"` — participants as columns, messages in time order, activation bars and alt/loop blocks. |
| Draw a **data model** (tables, columns, keys) | `figma_diagram` type:`"erd"` — entity-relationship diagram with crow's-foot cardinality, reporting the model problems that bite after a migration. |
| Draw a **business process** that crosses roles | `figma_diagram` type:`"activity"` — a swimlane diagram: one band per owner, the steps inside it, the handoffs between bands labelled with what is handed over. |
| Pin down what a **status field** is allowed to be | `figma_diagram` type:`"state"` — every value one entity can hold and every change that is allowed, with the event, guard and action on each. |
| **Change** a diagram you already drew | `figma_diagram` with `update` (the `frameId`) + `patch` — the frame stores its own model, so one finding costs one op, not the whole spec again. Read it first with `figma_read` op `get_diagram_spec`. |
| Find out what **already exists** in the file | `figma_read` op `get_page_model` (`scope:"file"` for every page) — each diagram frame remembers the model it was drawn from, so the file itself is the record. Worth one call at the start of a session. |
| Check the diagrams **agree with each other** | Nothing to call: `figma_diagram` cross-checks every draw against its page and returns `consistency`. |
| **Verify** what you just drew | `figma_read` op `layout_audit` (structural facts: overflow, clipping, truncation) — then `screenshot` once for human review. |
| Move tokens in/out of the file | `export_tokens` (read) / `importTokens`, `setupTokens` (write). |
| Learn the safe-default semantics, layout math, or recipes | `figma_docs` (`rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes` \| `style` \| `userflow` \| `activity` \| `erd` \| `sequence` \| `sitemap` \| `state`). |

The typical session: `figma_status` → `figma_rules` → (for a feature rather than a single screen, `figma_diagram` type:`"userflow"` first, once the user has agreed to map the flow) → `figma_write` (draw, reusing what the rule sheet showed) → `layout_audit` → fix → `screenshot` for the human.

---

## `figma_status`

No parameters.

Returns rich diagnostics — never a bare boolean:

```jsonc
{
  "pluginConnected": true,        // true | false = measured; null = UNKNOWN (see statusSource)
  "statusSource": "local",        // "local" (own bridge) | "leader" (read over /rpc) | "unknown"
  "statusError": "…",             // only when statusSource === "unknown": why the leader query failed
  "mode": "leader",              // "leader" | "follower"
  "port": 38470,
  "serverVersion": "0.3.0",
  "protocolVersion": 3,
  "bridgeAuth": "ok",             // "ok" | "missing"
  "plugin": {
    "version": "0.3.0",
    "apiVersionMatch": true,      // plugin protocolVersion === server PROTOCOL_VERSION
    "fileName": "My File",
    "pageName": "Page 1",
    "editorType": "figma"
  },
  "lastHeartbeatMs": 1200,
  "queueLength": 0,
  "pendingCount": 0,
  "sessions": [ /* session summaries */ ],
  "hints": [
    "All systems nominal. Draw with figma_write; verify with figma_read layout_audit."
  ]
}
```

`hints` is an ordered list, most actionable first. It surfaces (in order of how they're evaluated): follower mode, missing bridge auth, no plugin connected, protocol version mismatch, stale heartbeat, non-empty queue. If none apply, it returns a single "all nominal" hint.

---

## `figma_read`

```json
{ "op": "<operation name>", "params": { /* op-specific */ } }
```

`op` must be one of the read operations below. `params` is passed through to the plugin; unknown/extra keys are tolerated (schemas are permissive on shape, strict on identity fields like `nodeId`).

### Read operations

| Operation | Required params | Notes |
|---|---|---|
| `get_document_info` | — | Root document metadata. |
| `get_selection` | — | Currently selected node(s) in Figma (shallow — id/name/type). |
| `read_selection` | — (optional `detail`, `depth`) | **Deep**-read the current selection in one call — the selection-first editing entry point. Returns `{ count, nodes }`. |
| `get_design_context` | — (optional `nodeId`, `detail`, `depth`) | `detail: "sparse" \| "compact" \| "full" \| "design"`. A whole-page read (no `nodeId`) defaults to `sparse` since a page can be huge; a scoped read (with `nodeId`) defaults to `compact`. Depth-limited traversal. At `design` detail, paints/effects/typography are compacted (solid fills as hex, Figma-default fields omitted, empty arrays dropped). |
| `get_node` | `nodeId` (non-empty string) | Single node by id. |
| `get_nodes` | `nodeIds` (array, min 1) | Batch node fetch. |
| `search_nodes` | `query`, optional `nodeId`, `types`, `limit` | Search by name/type/text. Default `limit` is `50`; when more matched, the result carries `hasMore`/`totalMatched`. |
| `scan_text_nodes` | — | Enumerate text nodes (e.g. for i18n or QA sweeps). |
| `scan_nodes_by_types` | type filter params | Enumerate nodes matching given types. |
| `get_styles` | — | Paint/text/effect styles. |
| `get_variables` | — | Variable collections, modes, and variables. |
| `get_components` | — (optional `detail`, `depth`, `includeAnatomy`) | Local components / component sets. Default keeps a compact `id/name/type/key` shape; `detail:"design"` includes properties, variants and text layers. Add `includeAnatomy:true` for bounded subtree anatomy. |
| `get_component` | `componentId` or `nodeId` or `key` | Rich single-component read: component property definitions, variants, text layers, slots, usage hints and anatomy by default. |
| `get_library_component` | `key` | Import a component from a **published shared library** by key and read it richly — the serialization doubles as a reconstruction spec. The import races an internal timeout, with a hint pointing at library publish/permission issues. |
| `get_design_system_kit` | — (same evidence/depth limits as `generate_design_md`) | Structured JSON source: file/pages, rich styles/variables, local and external components, usage, screen summaries, observed patterns and extraction coverage. |
| `screenshot` | optional `nodeId`, `scale` | PNG returned as a real MCP **image block** the model can see (not a base64 text dump), so it counts as image tokens, not thousands of text tokens. `scale` defaults to `0.6` — tuned for cheap verification renders, not pixel-perfect export. |
| `export_node` | `nodeId` | Export as PNG/SVG/JPG/PDF (format passed in params). |
| `get_fonts` | families list | Availability check for a list of font families — use before assuming a font will render. |
| `export_tokens` | — (optional `format`, `collection`, `mode`) | Export Figma Variables as design tokens: `format: "dtcg"` (default) \| `"css"` \| `"tailwind"`. The write-side twin is `import_tokens` (two-way tokens). |
| `layout_audit` | `nodeId` | **The structured verify tool** — see below. |
| `design_fingerprint` | — | A hash of the file's design system, for checking whether a cached `design-kit.md` is still valid: compare it to the `<!-- dsfp:… -->` in the file. |
| `get_diagram_spec` | `nodeId` (a diagram `frameId`) | **The model a drawn diagram was made from**, read back off its frame — so a finding can be fixed with a [`patch`](#editing-a-diagram-instead-of-re-drawing-it) instead of the whole spec sent again. Returns `{ nodeId, kind, title, spec }`. Errors if the frame was not drawn by `figma_diagram`, or predates the model being stored. |
| `get_page_model` | — (optional `pageId`, `scope`) | **Every model the page holds**, so the tools can ask whether the diagrams agree with each other — see [Do the diagrams agree?](#do-the-diagrams-agree--optionscrosscheck). `scope: "file"` spans every page (opt-in: it must `loadAllPagesAsync`, which is slow on a big file). Each entry is `{ nodeId, kind, title, spec }`; a frame drawn before models were stored comes back flagged `stale`/`unreadable` rather than being omitted. |

### `layout_audit(nodeId)` — the structured verify tool

Walks the subtree rooted at `nodeId` and returns, per node:

```jsonc
{
  "id": "12:34",
  "name": "Card",
  "declared": { "x": 0, "y": 0, "w": 320, "h": 200 },
  "rendered": { /* absoluteBoundingBox */ },
  "overflowsParent": false,
  "clippedBy": null,          // parentId, or null
  "textTruncated": false,
  "zIndexWarnings": [],
  "styleWarnings": []         // non-blocking padding/radius/contrast hints
}
```

Plus a top-level `summary: { issues: [...], styleHints: [...] }`.

**Token-frugal by default**: only records that carry a finding are returned — a clean subtree comes back as just the summary plus `nodeCount`/`reportedCount` (a clean 22-node audit is a few hundred tokens instead of ~2.7k). Pass `verbose: true` for the full per-node dump.

**Use this after every non-trivial draw**, instead of eyeballing a screenshot. Screenshots remain useful for a final human-facing review, but `layout_audit` is the objective, data-driven check that layout is actually correct — overflow, clipping, and text truncation are structural facts, not visual judgment calls.

## `figma_write`

```json
{ "code": "<JavaScript>", "sessionId": "optional-string" }
```

Executes `code` in a Node `vm` sandbox with these globals available:

- `figma` — the proxy API (full reference below).
- `state` — a plain object persisted across calls **within the same session** (see [Session state](#session-state)).
- `console` — captured; output comes back in the tool result's `logs`.
- Standard JS globals.

**Banned:** `require`, `process`, `fetch`, `setTimeout`, `eval`. Everything else — including modern syntax — is allowed: optional chaining (`?.`), nullish coalescing (`??`), spread, `async`/`await`, destructuring. There are no artificial ES-version restrictions; Node's `vm` module supports the full modern grammar, so nothing needs banning there.

Every `figma.*` method returns a `Promise` (one bridge round-trip to the plugin), except `figma.batch(ops)`, which ships all operations in one round-trip with chunked streaming (see below).

Return a value from `code` to receive it as `result`. The tool's response shape is `{ ok, result, logs, warnings }`.

### The `figma.*` proxy API

#### Creation & mutation

| Method | Signature | Notes |
|---|---|---|
| `create` | `create(spec)` | `spec.type` is `FRAME`/`TEXT`/`RECTANGLE`/etc, plus `parentId`, size, `fills`, and layout helpers (`inset`, `align`, `insertAt`, `wrap`). FRAME/COMPONENT without `fill`/`fills` defaults to transparent. A node placed on the page that would overlap existing work is moved down clear of it (one `figma_write` call moves as a group); `allowOverlap: true` opts out. Padding supports uniform/object/flat-side spellings; radius supports `cornerRadius`, `borderRadius`, `radius`, and per-corner fields. Returns the created node (with `id`). |
| `modify` | `modify(nodeId, props)` | Patch properties on an existing node. |
| `delete` (alias `del`) | `delete(nodeId, { force })` | Remove a node. A COMPONENT / COMPONENT_SET with instances needs `force: true`; the instances stay and can *Restore component* (`instancesLeft` in the result), and removing a set's last variant removes the set (`componentSetDeleted`). Pages go through `deletePage`. |
| `clone` | `clone(nodeId, { parentId, insertAt })` | Returns `{ id, childMap }` — `childMap` maps **original** child ids to **cloned** child ids, so you can edit the right descendant of the clone without name-based search. |
| `move` | `move(nodeId, { x, y, parentId, insertAt })` | Reposition and/or reparent. |
| `resize` | `resize(nodeId, { w, h })` | |
| `group` | `group(nodeIds)` | |
| `ungroup` | `ungroup(nodeId)` | |
| `flatten` | `flatten(nodeId)` | |
| `batch` | `batch(ops, {resultDetail?})` | `ops: [{ op, params }, ...]`. `resultDetail: "ids"` trims each successful item's result to just its node id. See [Batch streaming](#batch-streaming). |

Drawing primitives beyond the basic shapes, all settable in the same `create` call:

| Spec field | Applies to | Effect |
|---|---|---|
| `points: [[x,y], …]` (or `[{x,y}, …]`) | `VECTOR` | A polyline in **parent** coordinates — the plugin normalizes it into a node-local path plus an x/y offset, so you never juggle two coordinate systems. `closed: true` closes and fills it (an arrow head). Raw `vectorPaths` still work for curves. |
| `pointCount` | `POLYGON`, `STAR` | `4` is a diamond, `3` a triangle. `STAR` also takes `innerRadius`. |
| `strokeCap`, `strokeJoin`, `strokeAlign`, `dashPattern` | any stroked node | Real dashes and arrow caps at create time — no follow-up `modify`. |
| `rotation` | any node | Applied **after** x/y and resize, so one `create` is enough (it used to need a second round-trip). |
| `w` on a `LINE` | `LINE` | A `LINE` now honours the width you ask for instead of keeping Figma's native 100px. |
| `clipsContent` | `FRAME`, `COMPONENT` | Also honoured by `modify`. It used to be read nowhere, so every frame kept Figma's clipping default and content meant to overhang (a badge, a shadow, a diagram's arrows) was cut off. |

#### Edit-in-place (modify existing designs)

These package write/modify logic that has no single-property equivalent — the core of the "select something on the canvas and change it" workflow.

| Method | Signature | Notes |
|---|---|---|
| `readSelection` | `readSelection({ detail, depth })` | Deep-read whatever the user has selected in one call — the entry point for selection-first editing. Returns `{ count, nodes }`. |
| `setSelectionColors` | `setSelectionColors(nodeId?, { from?, to, includeStrokes? })` | Recursively recolor SOLID fills (and strokes unless disabled) across a subtree. If `from` (hex) is given, only that color is replaced. Returns `{ changed }`. Great for recoloring an existing icon/illustration. |
| `setGradient` | `setGradient(nodeId, { type, stops, transform?, target? })` | `type` is `LINEAR`/`RADIAL`/`ANGULAR`/`DIAMOND`; `stops: [{ position: 0..1, color, opacity? }]`. `transform` defaults to the identity matrix `[[1,0,0],[0,1,0]]` so you rarely need it. `target` is `fills` (default) or `strokes`. |
| `setEffects` | `setEffects(nodeId, effects)` | `effects: [{ type: "DROP_SHADOW"\|"INNER_SHADOW"\|"LAYER_BLUR"\|"BACKGROUND_BLUR", color?, offset?, radius, spread?, visible?, blendMode? }]`. Packages the shadow shape agents commonly get wrong. |

`setText(nodeId, content)` is mixed-font-safe: on a text node with multiple fonts it loads every range's font before writing, so it won't crash on `figma.mixed`, and reports any font fallback that was applied.

```js
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, height: 200, layoutMode: "VERTICAL",
});
```

#### Design-system extraction

Use these before creating UI from an existing Figma file:

```json
{ "op": "generate_design_md", "params": { "depth": 3, "includeAnatomy": true, "includeScreens": true } }
```

The result is `{ "markdown": "...", "extraction": {...} }`. Save that markdown as `design.md` in the
codebase when the agent needs a durable implementation spec. For automation,
call `get_design_system_kit` or pass `includeJson:true`; both expose the source
material as structured JSON. Pass `includeAnatomy:true` when the agent needs component
subtrees; when set on `generate_design_md`, the markdown also includes a
depth-limited Anatomy list for each component. For one component, call
`get_component` with a component id from `get_components`.

`generate_design_md` is deliberately evidence-grounded rather than brand-template
driven. It reports its extraction scope and limits, distinguishes direct Figma
facts from observed frequency patterns, includes screen composition summaries,
and leaves UX intent/breakpoints unknown unless the file supports them. Component
entries include node id, key, set/default/variant ids, observed usage and a ready
`maxScreens`, `maxInstances` or `maxOutputChars`; limits omit whole sections so
tables and code fences remain valid.

Screen and component-usage evidence are enabled by default and bounded to 80
screen roots and 2,000 instances. Set `includeScreens:false` or
`includeComponentUsage:false` for a catalog-only fast path; raise `maxScreens`
or `maxInstances` when the extraction report says relevant evidence was omitted.

#### Tokens & variables

| Method | Signature | Notes |
|---|---|---|
| `setupTokens` | `setupTokens(tokensJson)` | DTCG-ish `{ colors, numbers, strings }` → Figma Variables. **Idempotent** — re-running with the same names updates values instead of duplicating. Result is stored in `state.tokens`. Sets values for **all modes** explicitly (fixes a light/dark bug present in earlier tools where only the current mode was set). |
| `applyVariable` | `applyVariable(nodeId, field, tokenName)` | Bind a node field (e.g. `"fills"`, `"cornerRadius"`) to a token by name. |
| `createVariable` | `createVariable({ name, value \| valuesByMode, type?, collection? })` | Create one variable. A single `value` is written to **all modes** explicitly; `valuesByMode` sets per-mode values. |
| `updateVariable` | `updateVariable({ variable, value \| valuesByMode })` | Update by name or id (`variable` / `name` / `variableId` all accepted). |
| `renameVariable` | `renameVariable({ variable, newName })` | Bindings follow the variable id — nothing rebinds. |
| `deleteVariable` | `deleteVariable({ variable, replaceWith?, force? })` | **Replace-gated**: scans document usages first; with `replaceWith` it rebinds them before removal, without it a used variable is refused unless `force: true`. |
| `exportTokens` | `exportTokens({ format?, collection?, mode? })` | Variables → `"dtcg"` (default) \| `"css"` \| `"tailwind"`. Pure serialization (`shared/token-format.ts`). |
| `importTokens` | `importTokens({ tokens \| dtcg \| modes })` | DTCG tree (or `{ modes: { light: tree, dark: tree } }`) → Figma Variables — the two-way twin of `exportTokens`. The multi-mode form needs a plan that allows more than one mode; a single `{ tokens, mode }` works anywhere. |

```js
await figma.setupTokens({
  colors: { primary: "#2563EB", surface: { light: "#FFFFFF", dark: "#0B0B0F" } },
  numbers: { "radius-md": 8 },
});
await figma.applyVariable(card.id, "fills", "surface");
```

After `setupTokens`, the session token map is available at `state.tokens` (name → value). Prefer `applyVariable` over re-writing a hex you already tokenized, so a single token edit re-themes everything.

**Modes are capped by the file's plan.** A variable collection is a table — one row per token, one **column** per mode — and a node binds to the row, which is what lets one setting re-theme a whole screen. Figma limits the columns by pricing tier: a Starter file gets **one**, so a per-mode value (`{ light, dark }`) is not available there at all; the paid tiers allow several, and the number has changed over time.

Every collection already owns its first column, so asking for one mode never spends one — `setupTokens`, `createVariable` and `importTokens` claim Figma's untouched `Mode 1` by renaming it, and only a genuine *second* mode can be refused. A mode **you** named is never renamed out from under you. When the cap is hit the call raises [`PLAN_LIMIT`](#error-codes) naming the limit Figma itself reported and the modes that already exist, so the fix is to send fewer:

```js
// Works on any plan — one value per token.
await figma.setupTokens({ colors: { surface: "#FFFFFF" } });

// Needs a plan with two or more modes.
await figma.setupTokens({ colors: { surface: { light: "#FFFFFF", dark: "#0B0B0F" } } });
```

#### Prototyping

| Method | Signature | Notes |
|---|---|---|
| `setReactions` | `setReactions(nodeId, reactions)` | **Replaces** a node's prototype reactions (it is not additive). Trigger/action enums and destination existence are validated plugin-side, which throws `INVALID_PARAMS` with a precise hint rather than writing a broken prototype. |

#### Userflow

| Method | Signature | Notes |
|---|---|---|
| `userflow` | `userflow(spec)` | Draw a userflow from a graph you derived from the spec. Same fields as [`figma_diagram` type:`"userflow"`](#type-userflow--the-screens-a-user-moves-through). Layout (dagre + orthogonal routing) runs server-side; the plugin only draws. Returns `{ frameId, nodes, warnings, stats }`, where `warnings` names the holes in the flow. |
| `reflowDiagram` | `reflowDiagram({ frameId? })` | Re-route a drawn diagram's arrows (userflow or activity) from where its boxes are NOW. Needed only for one rearranged while the plugin was closed — with it open, every drag re-routes live. Omit `frameId` to do every diagram on the page. Moves lines, labels and arrow heads; never moves a box. An arrow moved BY HAND is left alone and reported as `pinned` — pass `{ force: true }` to re-route those too. Returns `{ frames: [{ frameId, routed, pinned, hidden, missing, goneBoxes }] }`. |

#### Text & assets

| Method | Signature | Notes |
|---|---|---|
| `setText` | `setText(nodeId, content)` | Update a text node's characters. |
| `searchIcons` | `searchIcons(query)` | Resolves candidate canonical names across icon libraries via a cross-library alias map. **Never fetches an SVG** — cheap, use it to pick before paying for a `loadIcon` call. |
| `loadIcon` | `loadIcon(name, { library, size, color, parentId })` | Fetches the SVG server-side (from unpkg), caches it on disk, and hands it to the plugin to draw as vector nodes. Libraries: `lucide` (default), `ionicons`, `tabler`, `bootstrap-icons`. |
| `loadImage` | `loadImage(urlOrBase64)` | Load an image (URL or base64) onto the canvas. |

```js
const candidates = await figma.searchIcons("visibility"); // → [{ name: "eye", alias: "visibility", libraries: [...] }]
await figma.loadIcon("visibility", { library: "lucide", size: 24, color: "#F5F5F7", parentId: btn.id });
```

Common aliases: `visibility → eye`, `delete → trash`, `done`/`checkmark → check`, `close`/`cancel → x`, `add → plus`, `edit → pencil`, `settings → gear`, `more → more-horizontal`, `back → arrow-left`, `logout → log-out`, and roughly 40 more. Unknown names pass through unchanged. A miss throws `NODE_NOT_FOUND` with a hint to retry `searchIcons` or try a different `library`.

The "bridge is localhost-only" guarantee is about the Figma WebSocket connection specifically — icon (and image) fetching is an intentional, cached, allowed external call made by the **server**, not the plugin.

#### Reads (also usable from `figma_write` code)

`getNodeById(id)` / `getNode(id)`, `getNodes(ids)`, `getChildren(id)`, `getSelection()`, `readSelection({ detail, depth })`, `getDocumentInfo()`, `getDesignContext({ detail })`, `searchNodes({ query })`, `scanTextNodes()`, `scanNodesByTypes({ types })`, `getStyles()`, `getVariables()`, `getComponents()`, `getComponent({ componentId })`, `getLibraryComponent(key)`, `getDesignSystemKit()`, `generateDesignMd()`, `exportTokens({ format })`, `getFonts(families)`, `screenshot({ nodeId, scale })`, `exportNode({ nodeId, format })`, `layoutAudit(nodeId)`, `listChannels()`.

These mirror the `figma_read` operations one-to-one, so you can read and write in the same `figma_write` call without a separate round-trip through `figma_read`.

#### Misc

| Method | Signature | Notes |
|---|---|---|
| `currentPage` | `currentPage()` | |
| `createPage` | `createPage(name)` | Preflights the plan's page limit. On failure it does **not** throw mid-flow — it returns `{ fallback: "current-page", reason }` so a script can continue on the current page instead of crashing partway through. |
| `deletePage` | `deletePage(idOrName, { force? })` | Refuses the only page; switches away first if it is the current page. A page that still has layers throws `CONFIRM_REQUIRED` naming them — `force: true` after the user agrees. |
| `deleteStyle` | `deleteStyle(nameOrId, { type?, replaceWith?, force? })` | Local PAINT/TEXT/EFFECT/GRID style. **Replace-gated** like `deleteVariable`: a used style is refused with the layer count; `replaceWith` (same type) moves those layers first, text ranges included; `force` unlinks them. Library styles are read-only. |
| `deleteUnusedStyles` | `deleteUnusedStyles({ types?, keep?, confirm? })` | **Two calls, always.** Without `confirm` it deletes nothing and returns `{ wouldDelete, inUse, kept, confirmToken, caveat }`. Show the list to the user and ask; only after an explicit yes call again with the same filters and `confirm: confirmToken`. If the file changed in between the token is stale (`CONFIRM_REQUIRED`) and nothing is deleted. Scans this file only. |
| `setCurrentPage` | `setCurrentPage(pageIdOrOptions)` | Switches the visible Figma page by id, or by a unique exact name via `{name}`. Prefer page ids from `getDocumentInfo()` when names repeat. |
| `zoomToFit` | `zoomToFit(nodeId)` | |
| `overlay` | `overlay(spec)` | `spec: { color, opacity, parentId, insertAt? }`. Creates a **RECTANGLE** sized to the parent at the correct layer — never a semi-transparent FRAME, which would dim its entire subtree. |

```js
await figma.overlay({ parentId: screen.id, color: "#000000", opacity: 0.5, insertAt: "top" });
```

### Layout helpers (used inside `create`/`move` specs)

| Helper | Values | Effect |
|---|---|---|
| `inset` | `{ left, right, top, bottom }` | Pins a node to its parent's edges; the plugin derives `x/y/w/h` from the parent minus the insets. Omit a side to leave that dimension to the node's own size. |
| `align` | `"center-x" \| "center-y" \| "center"` | Centers without manual offset math. |
| `wrap` | `true` (on `TEXT` create) | Sets `layoutAlign: STRETCH`, `textAutoResize: HEIGHT`, and a sane default `lineHeight` (~1.45× font size); warns if the parent has no fixed width to wrap against. |
| `insertAt` | `"top" \| "bottom" \| { above: nodeId } \| { below: nodeId } \| index` | Z-order control on `create`/`move` — don't rely on creation order. |

Auto-layout sizing: setting `layoutMode: "VERTICAL" | "HORIZONTAL"` turns a frame into an auto-layout. Under a fixed-size parent, the constrained axis defaults to `counterAxisSizingMode: "FIXED"` unless you explicitly override it — this default is what prevents silent overflow. Use `primaryAxisSizingMode`/`counterAxisSizingMode: "AUTO"` (hug) or `"FIXED"` deliberately, and `layoutAlign: "STRETCH"` to make a child fill the cross axis.

---

## `figma_diagram`

**Seven** diagram kinds behind one tool with a `type`, because every tool description is paid for in tokens in every session and the shapes differ far more than the call does. `figma_userflow` was a separate tool up to 0.1.0; it is `type: "userflow"` here, with the same fields.

Pick by the question you are trying to settle:

| The open question | `type` |
|---|---|
| Who does each step, and what gets handed over? | `"activity"` |
| What is sent between systems, in what order? | `"sequence"` |
| What can this one record be, and what moves it? | `"state"` |
| What do we store, and how do the pieces refer to each other? | `"erd"` |
| Which screens does the user move through? | `"userflow"` |
| What pages exist, and where does each one live? | `"sitemap"` |

Every kind takes a model **you** derived from the spec, returns `warnings` about that model rather than about the drawing, and keeps its lines attached when a shape is dragged. None of them invents content: an empty answer means the spec did not say.

One call does the lot — check, draw, render-audit, and cross-check against the other diagrams on the page:

```json
{ "type": "state", "title": "Booking lifecycle", "text": "…", "options": { "checkFirst": true } }
```

| Response field | What it is |
|---|---|
| `frameId`, `name`, `box` | The frame drawn. `frameId` is what `update`, `patch` and `get_diagram_spec` take. |
| `nodes` | Your model ids → real Figma node ids, so you can keep working on one shape without searching by name. |
| `warnings` | Findings about the **model** — the deliverable. Act on each; never fill a field just to silence one. |
| `stats` | What was actually drawn. Compare it with what you sent: anything a diagram of that kind cannot mean is **dropped**. |
| `audit` | `layout_audit` of the new frame — overflow, clipping, truncation. On by default (`options.verify`), and free: no extra round trip. |
| `consistency` | Where this drawing contradicts its neighbours (`options.crossCheck`). See [Do the diagrams agree?](#do-the-diagrams-agree--optionscrosscheck). |

### The compact `text` form

Every kind except `userflow` accepts `text` **instead of** the arrays, at roughly a third of the tokens: one line per thing, `#` comments, and the ids that exist only to be referenced generated for you.

```yaml
# type: "sequence"
actor u "User"
system api "Booking API"
u ->> api: POST /pay
api -->> u: 201 Created
alt declined
  api -->> u: 402
end
```

One line per kind, to recognise the grammar:

| `type` | A line looks like |
|---|---|
| `sequence` | `actor u "User"`, then `u ->> api: POST /pay` (`-->>` reply, `--)` async), with `alt … else … end` / `loop … end` written where they apply. |
| `activity` | `lane sys "System"`, then `sys: pay ? "Paid?"` and `a > b "label"` (`~>` rework). |
| `erd` | a table, then its indented columns `id uuid pk!`, and `users.id 1-* bookings.user_id "books"`. |
| `state` | `paid "Paid" final ok` and `held -> paying: Event [guard] / action`. |

The full grammar per kind is `figma_docs({ section, level: "cheat" })` — read it once before your first one. A line the parser cannot read is **reported, never dropped**, so a typo surfaces as a finding rather than as a diagram quietly missing a step. `text` and the arrays draw the same diagram; `type: "userflow"` takes `mermaid` instead, which is a different grammar.

### `type: "userflow"` — the screens a user moves through

Draws a userflow: screen boxes, decision diamonds, labelled arrows, and return paths (cancel / retry / back) routed in side gutters instead of across the diagram. The one kind that takes `mermaid` rather than the compact `text` form. Also reachable from `figma_write` as `figma.userflow(spec)`.

**The graph is yours; the drawing and the proof-reading are the tool's.** Read the spec / PRD / code, enumerate the screens, the happy path, every error and edge case, then hand over the result. The tool never invents a node, merges a branch or guesses a label.

```json
{
  "title": "Book registration · scan by ISBN",
  "subtitle": "feature book-registration",
  "x": 80,
  "y": 200,
  "nodes": [
    { "id": "list",  "label": "My books",  "kind": "screen",   "cls": "happy", "screenId": "2.1", "slug": "my-books" },
    { "id": "scan",  "label": "Scan a book\nISBN field, 13 chars", "kind": "screen", "cls": "happy", "screenId": "2.3" },
    { "id": "valid", "label": "ISBN valid?", "kind": "decision" },
    { "id": "err",   "label": "E-001 · bad ISBN", "kind": "state", "cls": "error" },
    { "id": "done",  "label": "Book added", "kind": "terminal", "cls": "happy" }
  ],
  "edges": [
    { "from": "list",  "to": "scan",  "label": "Scan a new book" },
    { "from": "scan",  "to": "valid" },
    { "from": "valid", "to": "err",   "label": "no" },
    { "from": "valid", "to": "done",  "label": "yes" },
    { "from": "err",   "to": "scan",  "label": "Try again", "kind": "return" }
  ],
  "options": { "linkScreens": true }
}
```

| Field | Meaning |
|---|---|
| `title` (required) | Heading drawn on the frame. |
| `subtitle` | One-line context under the title. |
| `parentId`, `x`, `y` | Placement. Nothing is auto-placed — use the returned `stats.w`/`stats.h` to lay the next block out. |
| `nodes[]` | `{ id, label, detail?, kind?, cls?, screenId?, slug? }`. `kind`: `screen` (an artboard) · `state` · `decision` (a question) · `external` / `terminal` (legitimate ends). `cls` colours by meaning: `happy` green, `error` red, `edge` amber, `plain` white. |
| `edges[]` | `{ from, to, label?, kind?, fromAt?, toAt? }`. `kind:"return"` = go back / cancel / retry: drawn dashed in an outer gutter and kept out of the rank maths, which narrows the diagram substantially. `fromSide`/`toSide` pick the FACE (`top`/`right`/`bottom`/`left`) and `fromAt`/`toAt` (0..1) where along it — the declarative twin of dragging the arrow's end. |
| `mermaid` | A `flowchart TD` source used INSTEAD of `nodes`+`edges`. Understands `[box]` `{decision}` `([terminal])` `[[external]]`, `-->` `-.->` `==>`, `\|"label"\|`, chains, `:::class` and `class a,b happy`. |
| `options.rankdir` | `"TB"` (default) or `"LR"`. |
| `options.colorByTarget` | Arrows take the colour of the node they point at (default `true`). |
| `options.linkScreens` | Wire ON_CLICK → NAVIGATE from each screen box to the artboard whose name contains its `screenId`. Unmatched ids are reported, never guessed. |
| `options.font` | Font family for every label. Default Inter, whose metrics the layout is calibrated for — and which has **no CJK/Hangul glyphs**, so a Japanese or Korean flow renders blank boxes unless you pass a covering family (e.g. `"Noto Sans KR"`). Check it exists with `figma_read get_fonts`. |
| `options.dryRun` | Check the graph, return findings + size, draw nothing. |
| `options.liveRoute` | Keep the arrows attached to the boxes (default `true`) — see below. `false` freezes them as drawn. |

Returns `{ frameId, name, nodes: { flowId: figmaNodeId }, box, warnings, stats }` — `nodes` maps your graph ids to real Figma node ids, so you can keep working on individual boxes without searching by name.

#### The findings are the point

`warnings` reports the shape of the graph, not the drawing:

- a `decision` with fewer than two ways out — a question with one answer;
- a dead end that is not `terminal`/`external`;
- a node the start can never reach;
- an edge pointing at an id that was never declared (that edge is dropped);
- `screen` nodes with no `screenId`/`slug` — nothing ties them to a design.

These are the holes that stay invisible until the arrows exist. Read them, go back to the spec, add the missing case, call again — `options.dryRun` iterates without drawing.

#### Flow-aware screen drawing

`create` watches for page-level screens (≥320×320 on a page):

- **no userflow on the page** → warning: ask the user whether to map the flow first, then draw the UI.
- **a userflow exists that does not contain this screen** → warning: ask whether to update the flow in the same pass.

The tool only raises the question; it never draws or edits a flow on its own, and never blocks the screen being drawn.

### `type: "activity"` — swimlane activity diagram

A business process drawn as swimlanes: one band per owner (role, team, system), the steps inside the band that performs them, the handoffs between bands as labelled arrows. Use it when **who does this step** is the point; use [`type: "userflow"`](#type-userflow--the-screens-a-user-moves-through) when the subject is what the user sees.

```json
{
  "type": "activity",
  "title": "Purchase order approval",
  "lanes": [
    { "id": "req", "label": "Requester" },
    { "id": "mgr", "label": "Manager" },
    { "id": "fin", "label": "Finance", "detail": "SAP" }
  ],
  "nodes": [
    { "id": "s",      "label": "PO needed",          "kind": "start",    "lane": "req" },
    { "id": "draft",  "label": "Draft PO",           "lane": "req" },
    { "id": "review", "label": "Review PO",          "lane": "mgr" },
    { "id": "budget", "label": "Within budget?",     "kind": "decision", "lane": "mgr" },
    { "id": "reject", "label": "Reject with reason", "lane": "mgr", "cls": "error" },
    { "id": "pay",    "label": "Release payment",    "lane": "fin", "cls": "happy" },
    { "id": "done",   "label": "PO closed",          "kind": "end",      "lane": "fin", "cls": "happy" }
  ],
  "edges": [
    { "from": "s",      "to": "draft" },
    { "from": "draft",  "to": "review", "label": "submitted PO" },
    { "from": "review", "to": "budget" },
    { "from": "budget", "to": "pay",    "label": "yes" },
    { "from": "budget", "to": "reject", "label": "no" },
    { "from": "pay",    "to": "done" },
    { "from": "reject", "to": "draft",  "label": "rework", "kind": "return" }
  ]
}
```

| Field | Meaning |
|---|---|
| `type` (required) | `"activity"`. |
| `title` (required) | Heading drawn on the frame. |
| `subtitle` | One-line context under the title. |
| `parentId`, `x`, `y` | Placement. Nothing is auto-placed — use the returned `stats.w`/`stats.h` to lay the next block out. |
| `lanes[]` | `{ id, label, detail? }`, drawn in the order given (top→bottom for `LR`). One lane per party that DOES something. **Omit for a plain activity diagram** — see below. |
| `nodes[]` (required) | `{ id, label, detail?, lane, kind?, cls? }`. `lane` is required as soon as the diagram has lanes. `kind`: `action` · `decision` (needs ≥2 labelled branches) · `start`/`end` · `fork`/`join` · `event` · `external` (dashed). `cls` colours by meaning: `happy`, `error`, `edge`, `plain`. |
| `edges[]` | `{ from, to, label?, kind?, fromAt?, toAt? }`. `kind:"return"` = send back / rework / retry: dashed and routed outside every lane. Label every edge that crosses a lane with WHAT is handed over. `fromSide`/`toSide` pick the FACE and `fromAt`/`toAt` (0..1) where along it. |
| `options.rankdir` | `"LR"` (default): process runs left→right, lanes are horizontal. `"TB"`: downwards, lanes vertical. **Ask the user which they want** — it changes how the whole drawing reads. |
| `options.colorByTarget` | Arrows take the colour of the step they point at (default `true`). |
| `options.font` | Font for every label. Default Inter — **no CJK/Hangul glyphs**, so pass a covering family for those. |
| `options.liveRoute` | Keep the arrows attached when a step is dragged (default `true`). |
| `options.dryRun` | Check the process, return findings + size, draw nothing. |

Returns `{ frameId, name, nodes: { stepId: figmaNodeId }, lanes: { laneId: figmaNodeId }, box, warnings, stats }`. `stats.handoffs` is the number of arrows that cross lanes.

### Without swimlanes

Leave `lanes` out and leave `lane` off every step: you get a plain activity diagram — same notation (start/end, decisions, fork/join, rework routed outside), no bands. Nothing constrains the cross axis any more, so dagre's own positions are kept, and the corridors between ranks (and therefore the router) are unchanged. The handoff and idle-lane findings go quiet, because there are no lanes to hand anything over.

Put lane ids on the steps but no `lanes` array and the bands are **derived** from those ids in first-appearance order, labelled with the id — reported, so you can declare `lanes` properly when the order or the names matter. With `lanes` declared, a step that names no lane is drawn in a visible "(no lane)" band and reported: it is a finding, not a refusal.

#### What the activity findings report

`warnings` reports the process, not the drawing:

- an **unlabelled handoff** between two lanes — what actually crossed?
- a step whose `lane` does not exist (drawn in a visible "(no lane)" band, never filed under the first lane);
- no `start` (what triggers this?) or no `end` (what is the outcome, including the unhappy one?);
- a `decision` with fewer than two ways out, or branches with no condition;
- a `fork` whose branches never reach a `join` — nobody waits for the parallel work;
- a dead end that is not `end`/`external`; a step nothing leads into; a lane with no steps.

#### How an activity diagram is laid out

dagre decides the ORDER of the steps and nothing else — the cross axis belongs to the lanes, because a step drawn outside its own lane is wrong however good the graph layout was. The along-gap between two ranks is deliberately generous: it is the **corridor** a lane-crossing arrow travels in, so it never cuts through somebody else's step. An arrow that can go straight does; one that can do neither (rework going backwards, a skip across three ranks) goes around the outside of every lane.

Lane names read horizontally in a wide name strip rather than rotated — a rotated label means betting on Figma's rotation pivot, which buys nothing a wider strip does not.

### `type: "erd"` — data model

Tables with their columns, the keys that join them, and crow's-foot cardinality. Use it when the question is **what we store and how the pieces refer to each other**.

```json
{
  "type": "erd",
  "title": "Loan origination",
  "entities": [
    { "id": "cus", "name": "customers", "cls": "happy", "attributes": [
      { "name": "id", "type": "uuid", "key": "pk", "required": true },
      { "name": "national_id", "type": "varchar(12)", "required": true }
    ]},
    { "id": "app", "name": "loan_applications", "detail": "core.loan", "attributes": [
      { "name": "id", "type": "uuid", "key": "pk", "required": true },
      { "name": "customer_id", "type": "uuid", "key": "fk", "required": true },
      { "name": "amount", "type": "numeric(14,2)", "required": true }
    ]}
  ],
  "relations": [
    { "from": "cus", "to": "app", "fromField": "id", "toField": "customer_id", "label": "applies for", "toCard": "zero-many" }
  ]
}
```

| Field | Meaning |
|---|---|
| `entities[]` (required) | `{ id, name, detail?, attributes[], cls?, external? }`. `attributes[]` is `{ name, type?, key?, required? }` in reading order; `key` is `pk` · `fk` · `pfk`. `external` marks a table another system owns: drawn dashed, exempt from the primary-key finding. |
| `relations[]` | `{ from, to, fromField?, toField?, fromCard?, toCard?, label?, identifying? }`. **Name the columns** — that is what makes the line attach to the row that implements the relationship, and what lets a reader check the drawing against the schema. Cardinality is crow's foot: `one` · `many` · `zero-one` · `zero-many` · `one-many` (default one → many). |
| `options.rankdir` | `"LR"` (default) spreads the tables left→right; `"TB"` stacks them downwards. |

Returns `{ frameId, name, entities: { entityId: figmaNodeId }, box, warnings, stats }`.

**The findings**: a table with no primary key; a relationship naming a column that does not exist; a many-to-many with no join table; a type mismatch across a key; a relationship with no column named; an orphan table; duplicate column names; snake_case mixed with camelCase.

### `type: "sitemap"` — what the product is made of

Every page, and which page contains which. Draw it **before** a screen-drawing session: "which screens exist" is the question such a session assumes an answer to and rarely has one for.

**Its edges are containment, not navigation.** `A` above `B` means "B lives under A", never "the user goes from A to B". They are different relations over the same boxes, and a sitemap drawn as a second userflow is the commonest way this kind is wasted — so there is **no `edges` array**, no arrow token in the compact form, and no arrow heads on the drawn lines. Containment is a `parent` on the page itself.

```json
{
  "type": "sitemap",
  "title": "CRM · kiến trúc thông tin",
  "pages": [
    { "id": "crm", "label": "CRM" },
    { "id": "dash", "label": "Dashboard", "parent": "crm", "screenId": "dashboard" },
    { "id": "contacts", "label": "Liên hệ", "parent": "crm" },
    { "id": "detail", "label": "Chi tiết liên hệ", "parent": "contacts" },
    { "id": "reports", "label": "Báo cáo", "kind": "section", "parent": "crm" },
    { "id": "revenue", "label": "Doanh thu", "parent": "reports" },
    { "id": "activity", "label": "Hoạt động", "parent": "reports" },
    { "id": "psp", "label": "Cổng thanh toán", "kind": "external", "parent": "crm" }
  ]
}
```

Or in the compact form, where **indentation is the model**:

```
crm "CRM"
  dash "Dashboard" screen:dashboard
  contacts "Liên hệ"
    list "Danh sách" screen:contacts-list,contacts-empty
    detail "Chi tiết liên hệ" screen:contact-detail / chỉ chủ sở hữu xem được
  reports "Báo cáo" section
    revenue "Doanh thu"
    activity "Hoạt động nhân viên"
  psp "Cổng thanh toán" external
```

| field | meaning |
| --- | --- |
| `parent` | the page this one **lives under**; omit on the root. Not the page you came from |
| `kind` | `page` (default) · `section` (a nav heading with no page of its own) · `modal` · `external` |
| `screenId` | the artboard(s) it is designed as — one id or a **list** (the page plus its states). What the userflow cross-check and the coverage check match on |

**The findings**: a `parent` that does not exist (dropped, with the size of the subtree that went with it); a containment cycle; more than one page with no parent; deeper than `options.maxDepth` (default 4, i.e. three clicks in); a `section` grouping fewer than two pages; two siblings with the same label; a flat list with no parents at all; an `external` page with pages inside it.

Three silences are deliberate. A **`page`** with a single child is fine — "Liên hệ → Chi tiết liên hệ" is correct IA, and only a `section` is checked for it. The same label under **different** parents is two menus, not a clash. And a `modal` does not count as a level, because it opens on top of a page rather than being another click in.

**The cross-check with the flows** is the reason to have this kind beside `"userflow"`. On one page, `consistency` reports as `ia-drift`: a screen the flow walks through that no sitemap has a page for, and one screen carrying two ids. The reverse — a page no flow reaches — is **not** reported: a userflow draws one journey, so most of a real IA is off it, and reporting that would put a dozen true and useless lines on every page holding both kinds.

**Does the IA match the designs?** A sitemap draw — and `figma_read op:"get_page_model"`, which re-checks everything **without drawing** — returns a fourth field, `coverage`: `undesigned` (pages whose artboards are not on the canvas) and `orphans` (artboards no page claims), plus a `stats` line. It is not a warning: a page with no design yet is a fact about a project in progress, not a defect. It stays silent until the sitemap actually names artboards, and the `orphans` direction is only meaningful because a page names **all** of its artboards — otherwise every empty state would read as a screen with no home.

**Layout**: the one kind that does not use dagre by default. A tree has no edge crossings to minimise, and dagre's ordering pass would reorder siblings — which in an IA is the nav order, i.e. content. `options.layout: "dagre"` is there if you prefer its packing; `options.rankdir: "LR"` reads better past three levels. Dragging a page re-routes its lines; dragging a line's END does **not** reconnect it, because moving a page in the tree is a change to the model — patch its `parent` instead.

### `type: "sequence"` — exchange over time

Participants as columns, messages as arrows in the order you list them, activation bars derived from the calls and their replies, and `alt`/`opt`/`loop`/`par` blocks. Use it for an integration or an API contract, where **what is sent and what comes back** is the thing people argue about later.

```json
{
  "type": "sequence",
  "title": "Ký hợp đồng bằng OTP",
  "participants": [
    { "id": "kh",  "name": "Khách hàng", "kind": "actor" },
    { "id": "app", "name": "App", "detail": "mobile" },
    { "id": "los", "name": "LOS", "detail": "loan-svc" }
  ],
  "messages": [
    { "id": "m1", "from": "kh",  "to": "app", "label": "Bấm Ký hợp đồng" },
    { "id": "m2", "from": "app", "to": "los", "label": "POST /sign-otp" },
    { "id": "m3", "from": "los", "to": "los", "label": "sinh mã 6 số", "note": "TTL 5 phút" },
    { "id": "m4", "from": "los", "to": "app", "label": "202 { otpSentAt }", "kind": "return" }
  ],
  "fragments": [
    { "kind": "alt", "label": "OTP đúng", "messages": ["m4"], "else": { "label": "OTP sai", "messages": [] } }
  ]
}
```

| Field | Meaning |
|---|---|
| `participants[]` (required) | `{ id, name, detail?, kind?, cls? }`, left to right. `kind`: `actor` (a person, drawn dark) · `system` · `external` (dashed) · `queue` · `db`. |
| `messages[]` (required) | `{ id, from, to, label, kind?, note?, cls? }` **in time order — the array order IS the diagram's order**. `kind`: `sync` (default; solid, filled head, and it starts an activation bar on the callee) · `async` (solid, open head) · `return` (dashed, open head, closes the bar). `from === to` draws a self-message. `note` hangs a small note under the arrow. |
| `fragments[]` | `{ kind, label, messages[], else? }` around a **contiguous** run: `alt` · `opt` · `loop` · `par` · `break`. |

Returns `{ frameId, name, participants: { id: figmaNodeId }, box, warnings, stats }`.

**The findings**: a reply with no call to answer; a call the diagram never answers (only when it answers others — and a message from an `actor` or a self-message is exempt); an `alt` with no else; a fragment that skips a message; an unlabelled message; a participant nobody talks to.

Dragging a participant moves its whole **column** — lifeline, bars, every arrow touching it, the fragment boxes that span it. What never moves is TIME: the row a message sits on is its order.

### `type: "state"` — the lifecycle of one entity

Every value one entity can hold, and every change that is allowed. Reach for it whenever a spec has a status field: the set of legal values and legal transitions is what a developer needs to write the guard clause and a tester needs to know what to try, and it is the part of a spec that is almost always left implicit.

```json
{
  "type": "state",
  "title": "Vòng đời hợp đồng vay",
  "states": [
    { "id": "begin",  "kind": "initial" },
    { "id": "draft",  "label": "Nháp", "entry": "sinh mã HĐ" },
    { "id": "review", "label": "Chờ duyệt", "do": "chấm điểm tín dụng" },
    { "id": "signed", "label": "Đã ký", "cls": "happy" },
    { "id": "closed", "label": "Đã tất toán", "kind": "final", "cls": "happy" }
  ],
  "transitions": [
    { "from": "begin",  "to": "draft" },
    { "from": "draft",  "to": "review", "event": "Gửi duyệt", "guard": "đủ hồ sơ", "action": "notify(QLTD)" },
    { "from": "draft",  "to": "draft",  "event": "Lưu nháp" },
    { "from": "review", "to": "signed", "event": "Duyệt" },
    { "from": "review", "to": "draft",  "event": "Yêu cầu bổ sung", "kind": "return" },
    { "from": "signed", "to": "closed", "event": "Trả hết nợ" }
  ]
}
```

| Field | Meaning |
|---|---|
| `states[]` (required) | `{ id, label?, kind?, entry?, do?, exit?, detail?, cls? }`. `kind`: `state` (default) · `initial` (the starting dot — **exactly one**) · `final` (a ring; several is fine) · `choice` (a diamond, branching on a condition) · `fork`/`join`. `entry`/`do`/`exit` are drawn in a second compartment under a rule, which is what makes a reader read "state" and not "step". |
| `transitions[]` (required) | `{ from, to, event?, guard?, action?, kind?, cls? }`, drawn the UML way: **`event [guard] / action`**. `from === to` is a self-transition and draws as a loop. `kind: "return"` marks a way back (reopen, retry, revert): dashed, routed around the outside. |

Returns `{ frameId, name, nodes: { id: figmaNodeId }, box, warnings, stats }`.

**The findings**: a state nothing can reach from the initial one; a state with **no way out** that is not marked `final`; **two transitions leaving one state on the same event with no guard to choose between them** — whichever the implementation checks first wins; a `final` state with a way out; a transition into the initial dot; a `choice` that does not branch or whose branches are unlabelled; a `fork` with no `join`; a transition that never says what triggers it.

The last one has a deliberate exemption: a state with a `do` activity may leave by an unlabelled transition, because that is exactly what UML's *completion transition* means. One unguarded branch of a `choice` is likewise fine — it reads as the `else`.

### Drawing a whole set in one call

`diagrams: [...]` draws several diagrams at once — one entry per diagram, each with its own `type`/`title`/content — and **places them for you**:

```json
{
  "diagrams": [
    { "type": "state",   "title": "Vòng đời vé",      "text": "…" },
    { "type": "erd",     "title": "Dữ liệu vé",       "text": "…" }
  ],
  "place": "column", "x": 0, "y": 0, "gap": 250
}
```

Sizes are known before anything is drawn, so you never compute `x`/`y` from the previous box and two frames never land on top of each other at `0,0`.

A new frame also never lands on top of work that was already on the page: if the spot it was given is taken, it slides down until it is clear — keeping its `x` — and a warning names what was in the way and where it went instead. The set's cursor follows the frame that actually landed, so the diagram after a moved one is stacked under it rather than back on the obstacle. A frame redrawn in place (`into`) is exempt: it stays exactly where the user dragged it.

| Field | Meaning |
|---|---|
| `place` | `"column"` (default) stacks frames downwards from `x`/`y`, `"row"` lays them rightwards, `"none"` leaves every entry at its own `x`/`y`. An explicit `x`/`y` on an entry always wins. |
| `gap` | Px between frames (default `250`). |

Findings come back per entry, each prefixed with its title, and `stats` carries `nextY` (or `nextX`) so the next call can continue the run. `consistency` is reported **once** for the set, from the last entry — which is the only one that saw all the others.

An entry may carry its own `update` (and `patch`): that frame keeps its id and its position and takes **no slot** in the placement. That is how you re-run a set without ending up with every diagram on the page twice.

`options.checkFirst` is all-or-nothing across the set: any finding anywhere and nothing is drawn (`checkedOnly: true`). If a draw fails mid-set the response says so out loud — `diagrams` lists the frames that did land and `failedAt` names the entry that stopped it.

### Editing a diagram instead of re-drawing it

A finding says the handoff has no label. Re-sending the whole spec to fix one string is how ~73% of the JSON an agent emits turns out to be spec it already sent. So the frame **stores the model it was drawn from**, and two parameters work off it:

| Field | Meaning |
|---|---|
| `update` | The `frameId` a diagram tool returned. Redraws **that** frame instead of making a new one: it keeps its id, so comments on it, prototype links into it, and wherever the user dragged it all survive. Without `patch`, the spec in this call replaces what the frame holds. |
| `patch` | Change the model the frame already stores. Needs `update`, and **nothing else of the model** — the frame is the source. |

```json
{
  "update": "140:5914",
  "patch": [
    { "collection": "edges", "where": { "from": "draft", "to": "review" }, "set": { "label": "bản thảo" } },
    { "collection": "states", "add": { "id": "expired", "label": "Hết hạn", "kind": "final" } },
    { "collection": "transitions", "add": { "from": "held", "to": "expired", "event": "Timeout" } },
    { "set": { "subtitle": "rev 3" } }
  ]
}
```

Each op is one of:

| Op | Shape | Notes |
|---|---|---|
| set | `{ collection, id \| where \| at, set: {…} }` | Merges fields into the selected member. A **dotted key** reaches inside: `"options.policies.hold-minutes": 15`, `"attributes.2.type": "enum(a\|b)"`. `null` **removes** a field — how a state stops being `final`. |
| add | `{ collection, add: {…}, after? }` | Appends; `after` (an id or a selector) says where instead. |
| remove | `{ collection, remove: <id> }` | Or `remove: true` with `at`/`where`. |
| diagram field | `{ set: {…} }` | Omit `collection` to set a field on the diagram itself — `title`, `subtitle`, `system`, `options`. |

`collection` is any array of that kind: `messages`, `entities`, `transitions`, `links`, `nodes`, `edges`, `lanes`, `states`, `actors`, `participants`, `fragments`, `relations`. Select a member by `id`, by `where: { from, to }` for the collections that have none, or by `at: <index>`.

Ops apply **in order** — `add` then `set` on the thing just added is the obvious two-step change, and an `at:` index means the position at the time that op runs. The result is then checked and redrawn like any other spec: a patch may only produce a spec, never skip the checker. `patched` in the response lists each op as applied.

Read what is there first with `figma_read` op `get_diagram_spec`, `{ nodeId: frameId }`.

### Rules that have a value — `options.policies`

The hold lasts 10 minutes. Payment may be tried 3 times. Retyped as prose into four diagrams — "Giữ ghế 10 phút", `[n < 3]`, "up to 3 attempts" — one gets updated and the others do not, and nothing catches it, because each label is just a string and every diagram is still perfectly legal.

So the label stops carrying the number and **references** it:

```json
{ "options": { "policies": { "hold-minutes": 10, "retry-attempts": 3 } } }
```

| In the spec | Drawn as |
|---|---|
| `"Giữ ghế @hold-minutes phút"` | `Giữ ghế 10 phút` |
| `"Declined [n < @retry-attempts]"` | `Declined [n < 3]` |

A reference is `@name` at the start of a string or after whitespace or a bracket — so `user@example.com` and an `@` inside an identifier are left alone. An unknown name is left as written rather than blanked.

Two things follow, and they are the point. A label cannot drift from the value, because it **is** the value. And the reference survives into the stored model — substitution happens on the way to the *layout*, never on the way to the model — so `get_page_model` can say which frames depend on `hold-minutes`, and changing it is one patch per frame:

```json
{ "update": "140:5914", "patch": [{ "set": { "options.policies.hold-minutes": 15 } }] }
```

Two diagrams quoting one rule differently is then reported as a `policy-drift` finding, because neither of them holds the number.

### Do the diagrams agree? — `options.crossCheck`

Every other checker here reads **one** model and asks whether it is a legal diagram of its kind. None can see the diagram next to it — so the mistake nobody catches is the one where two views of the same business are each well-formed and say different things. On by default; the page's models come back with the draw, so it costs no round trip. Findings arrive as `consistency`:

| `rule` | What it caught |
|---|---|
| `lifecycle-drift` | The state diagram draws a status the ERD column cannot store, or the column enumerates one the lifecycle can never reach. |
| `name-drift` | One role, two names — "User" on the sequence, "Khách hàng" on the activity lane. |
| `id-drift` | The same thing referred to by two different ids. |
| `policy-drift` | Two diagrams quote the same numbered rule differently (see `options.policies`). |

Each finding carries the `frames` it involves, because a finding you cannot locate is not actionable. **These are advisory and never block a draw**: a page half-way through being drawn is *supposed* to disagree with itself.

This works because a diagram frame remembers the model it was drawn from, which makes the Figma file itself a machine-readable record of everything anyone has drawn in it — no glossary to maintain, and no dependence on one chat remembering what another chat did last week. It is the thing mermaid and plantuml cannot do at all, because there every diagram is an island.

Frames drawn before the model was stored are reported as `unreadable`/`stale` rather than skipped silently: a page that *looks* compared but holds a diagram no check ever saw is worse than an admitted gap. One redraw (`update` with its spec) brings it in.

Ask the whole file rather than one page with `figma_read` op `get_page_model`, `{ scope: "file" }` — the call to make **once**, at the start of a session, to find out what already exists. It is opt-in because it must load every page of the document, which is slow on a big file; the check that runs on every draw stays page-local for that reason.

### `options` reference

| Option | Default | Meaning |
|---|---|---|
| `rankdir` | `"LR"` (`"TB"` for userflow) | `LR` runs a process left→right with horizontal lanes, `TB` downwards. For `state`/`userflow` it is simply which way it reads. **For `activity`, ask the user which** before drawing. |
| `font` | `Inter` | Font for every label. Inter has **no CJK/Hangul glyphs** — a Vietnamese diagram is fine, a Japanese or Korean one renders **blank** without e.g. `"Noto Sans KR"`. Check with `figma_read get_fonts`. |
| `colorByTarget` | `true` | Colour each arrow by the class of what it points at. |
| `liveRoute` | `true` | Keep arrows attached when a shape is dragged. `false` freezes them as drawn. |
| `linkScreens` | `false` | `type:"userflow"` only — wire ON_CLICK → NAVIGATE from each screen box to the artboard whose name contains its `screenId`. Unmatched ids are reported, never guessed. |
| `dryRun` | `false` | Check and return findings + size **without drawing**. It returns before the create op is dispatched, so it never reaches the plugin and proves nothing about the write path — use `figma_status` for that. |
| `checkFirst` | `false` | Check, and draw **only** if there are no findings. Dirty → `checkedOnly: true` + the findings, nothing drawn. All-or-nothing across a `diagrams` batch. |
| `verify` | `true` | Return `layout_audit` of the frame just drawn as `audit`. Costs no round trip. |
| `policies` | — | Rules that have a value: `{ "hold-minutes": 10 }`, referenced from any label as `@hold-minutes`. |
| `crossCheck` | `true` | Compare the drawing against the other diagrams on its page, and return disagreements as `consistency`. |

### The arrows follow the shapes — in every kind

True of all six diagram kinds, not just this one. Dragging or resizing a shape re-routes every line touching it while the plugin is open, and `figma.reflowDiagram()` fixes a diagram rearranged with the plugin closed. Dragging a line's END reconnects it: the connection point is adopted into the stored graph and the line re-routed through it, still following the shapes. `fromSide`/`toSide` + `fromAt`/`toAt` are the declarative twin, for pulling two crossing lines apart up front.

Two kinds report rather than apply a move, because the move means something the drawing cannot decide:

- **activity** — drag a step into ANOTHER lane's band and the relaning is reported, not applied. Whether the process changed hands is the spec author's call, so re-run `figma_diagram` with the new lane if it did.

#### The arrows follow the boxes

Figma Design has no connector object (`figma.createConnector()` is FigJam-only), so every arrow here is an ordinary vector. The frame therefore stores its own graph, and the plugin re-routes:

- **while the plugin is open**, dragging or resizing a box re-routes every arrow touching it — lines, arrow heads, edge labels and the return-path gutters — and grows the frame if a box is dragged past its edge;
- **deleting a box** hides the arrows that pointed at it. Hidden, not deleted: an undo brings the box back and the next re-route shows them again. An arrow you hid yourself stays hidden;
- **with the plugin closed** nothing follows anything, so a rearranged flow is put right on demand with `figma.reflowDiagram()` (all flows on the page) or `figma.reflowDiagram({ frameId })`.

A reflow moves LINES, never boxes: the layout is not re-run, because re-running it would undo the drag it is answering. Rank-crossing arrows come back as plain elbows (out, sidestep halfway, in) instead of following dagre's waypoints — redraw the flow to get the tuned layout back. Renaming a `flow:<id>` or `edge <id>` layer breaks the pairing, and that arrow is then left alone (`reflowDiagram` reports it as `missing`).

Frames drawn before this version carry no stored graph; redraw them once to make their arrows follow.

#### Dragging an arrow's end reconnects it

Each edge is ONE layer: the arrow head is a stroke cap on the line, not a separate triangle. So drag the head onto another part of a box — another face, another spot on the same face — and the line is **re-routed** to leave and arrive there properly. The connection point is written into the diagram's stored graph, which means it survives the plugin closing *and* the arrow keeps following its boxes from the point you chose.

An edit that says nothing about attachment (a middle bend nudged, the line parked somewhere) cannot be read as an instruction, so it is left exactly as you left it and reported as `pinned`. `reflowDiagram({ force: true })` puts everything back under automatic routing and forgets the points that came from dragging; a `fromSide`/`toSide` in the spec survives, because that one is the spec's instruction.

The declarative twin of the drag is `fromSide`/`toSide` (which face) with `fromAt`/`toAt` (where along it) on the edge.

## `figma_rules`

No parameters. Runs `get_styles`, `get_variables`, and `get_components` **in parallel** (`Promise.allSettled`, so one failing read doesn't block the others) and formats the results as one markdown rule sheet:

```markdown
# Design-system rule sheet

## Styles
**paint**: Primary/500, Surface/Background
...

## Variables
- **Colors** (modes: Light, Dark): primary, surface, on-surface

## Components
- Button/Primary
- Card/Default

```

If a read fails, its section prints `_Could not load: <message> (<hint>)_` rather than failing the whole call. Call this before drawing so the agent reuses existing tokens/components instead of hardcoding new ones.

---

## `figma_docs`

```json
{ "section": "state", "level": "cheat" }
```


`level` picks how much comes back: `"cheat"` is just the call shape and the field tables — a fraction of the tokens, and enough to write the call; `"full"` (the default) adds the findings that kind reports, the notation traps and the layout notes. Read `cheat` to write a diagram call, `full` the first time you draw that kind or when a warning needs explaining.

Read **`style`** when you are drawing a screen and the file has *no* `design.md` and *no* existing design system to reuse: it is a brand-neutral default type scale, 4px spacing grid, tinted palette and layered-elevation ramp, plus the anti-lifeless rules (hierarchy via size+weight+color, in-group spacing tighter than between-group, no pure `#000`/`#FFF`, line-height that shrinks as size grows). Falling back to it beats inventing values ad hoc; change one `color/primary` and the rest still holds together. Each section is a concise markdown page written to teach the calling agent the safe-default semantics — the same "error messages teach the AI" philosophy applied to documentation.

---

## Error codes

Every failure — from a tool call, a `figma.*` proxy call, or a bridge/plugin error — is shaped `{ code, message, hint }`. Read `hint`: it names the next concrete step.

| Code | Meaning | Typical fix | Retryable? |
|---|---|---|---|
| `NOT_CONNECTED` | No plugin connected, or the bridge is unavailable on this process. | Call `figma_status`; open the Figma plugin if `pluginConnected` is `false`. If it is `null` (unknown — a follower could not reach the leader) the plugin may well be fine: retry the operation rather than restarting the plugin. Restart the server if it persists. | ✅ Yes |
| `NODE_NOT_FOUND` | A referenced `nodeId` (or icon name) doesn't exist. | Re-fetch via `get_selection`/`get_node`, or re-run `searchIcons` / try a different `library`. | ❌ No |
| `FONT_UNAVAILABLE` | Requested font family isn't installed/available. | The response also reports `{ requestedFont, resolvedFont, reason }` — the plugin already fell back (requested → Inter → system); use `get_fonts` to check availability up front if it matters. | ❌ No (already fell back) |
| `INVALID_PARAMS` | Params failed validation (wrong shape, missing required field, empty `nodeId`, etc). | Fix the shape per `figma_docs(section: "api")` or the message's `path`. | ❌ No |
| `PLUGIN_TIMEOUT` | The plugin didn't respond within the operation's timeout budget. | Retry; if it recurs, check `figma_status` for a stale heartbeat (Figma window minimized/asleep). | ✅ Yes |
| `QUEUE_FULL` | Too many pending operations queued to the plugin. | Batch related ops with `figma.batch()` instead of firing many individual calls; wait and retry. | ✅ Yes |
| `PAGE_LIMIT` | `createPage` hit the file's page-count limit. | Handled gracefully already — `createPage` returns `{ fallback: "current-page", reason }` instead of throwing; use the current page. | ❌ No (graceful fallback) |
| `PLAN_LIMIT` | A Figma API the file's pricing tier caps. Currently raised by variable **modes**: a collection may hold N modes and N depends on the plan (one on Starter). | The message names the limit Figma itself reported and lists the modes that exist. Send one value per token instead of a per-mode map (`"surface": "#FFFFFF"` rather than `{ light, dark }`), or a subset of modes that fits. Not a bug to retry around — the answer is fewer modes or a different plan. | ❌ No |
| `CONFIRM_REQUIRED` | A destructive op needs a second, explicit step: `deletePage` on a page with layers, or `deleteUnusedStyles` with a missing/stale `confirm` token. | Show the user what would be lost and ask. Then `force: true` (page) or preview again and pass the new `confirmToken`. | ❌ No (ask the user) |
| `COMPONENT_IN_USE` | A component/component-set operation conflicts with existing instances (also a variable or style still in use). | Inspect via `get_components`/`get_selection` before retrying the mutation. | ⚠️ Maybe |
| `UNAUTHORIZED` | A follower's `/rpc` request lacked a valid bridge auth token (auto-refresh from `leader-<port>.json` already failed). | Restart the server so a fresh `leader-<port>.json` token is written; don't hand-edit that file. | ✅ Yes (after restart) |
| `SANDBOX_ERROR` | The `figma_write` code threw inside the `vm` sandbox (syntax error, runtime exception, or hit a banned global). | Read the message; check for `require`/`process`/`fetch`/`setTimeout`/`eval` usage — those are banned; everything else in modern JS is fine. | ❌ No |
| `UNSUPPORTED_OPERATION` | An unknown `op` name was passed to `figma_read` or inside a `batch` item. | Check spelling against the operation tables above; `figma_docs(section: "api")` lists the full surface. | ❌ No |
| `INTERNAL` | Unclassified server-side error. | Treat as a bug; the `message` carries the underlying detail. | ⚠️ Maybe |

### Retryable errors (for agent retry logic)

**Always safe to retry:**
- `NOT_CONNECTED` — bridge came back online
- `PLUGIN_TIMEOUT` — plugin may have been busy; operation is idempotent
- `QUEUE_FULL` — queue drained; retry now

**Retry after recovery:**
- `UNAUTHORIZED` — only after restarting the server

**Never retry (agent error):**
- `INVALID_PARAMS` — agent must fix the params
- `SANDBOX_ERROR` — agent must fix the code
- `NODE_NOT_FOUND` — agent must fetch fresh ids
- `UNSUPPORTED_OPERATION` — agent used wrong op name
- `PLAN_LIMIT` — the plan caps it; agent must ask for less (fewer modes), not again

**Contextual:**
- `CONFIRM_REQUIRED` — never retry on your own; the user decides
- `COMPONENT_IN_USE` — retry after inspecting/understanding the conflict
- `INTERNAL` — log and treat as unrecoverable unless error message suggests otherwise

---

## Warnings

Some operations succeed but return non-fatal `warnings: string[]` alongside the result — read them, don't ignore them. Known cases:

- **Clipping**: creating a node whose `x + w > parent.w` (or `y + h > parent.h`) under a `clipsContent` parent still succeeds, but the response carries `warnings: ["will be clipped by parent …"]`.
- **Opacity on a FRAME**: passing `opacity < 1` on a `FRAME` create warns that opacity dims the entire subtree, and suggests `figma.overlay()` instead.
- **Text wrap without a fixed-width parent**: `wrap: true` warns if the parent has no fixed width — there's nothing to wrap against.

In `figma_write`, per-call warnings surface on the tool result (`{ ok, result, logs, warnings }`); warnings raised by items inside `figma.batch()` are aggregated into that same call-level `warnings` array.

---

## Batch streaming

`figma.batch(ops)` — the `batch` write operation, taking `{ ops: [{ op, params }, ...] }` (the plugin also accepts an `items` key as an alias) — executes many operations in **one MCP round-trip**, but the server-to-plugin leg streams them in **chunks of 20** (`BATCH_CHUNK_SIZE`):

- Each chunk boundary — and the very last item overall — emits a progress ping (`{ done, total, note }`) back to the server, which **resets the per-chunk timeout** (30 s per chunk, not 30 s total).
- Execution is **sequential with per-item try/catch**: one failing item does not abort the batch. Results are **partial-commit** (no rollback) — everything that succeeded stays on the canvas.
- The response reports every item's outcome with its **original index**, sorted ascending, so results line up with your input array even when some items were rejected before dispatch:
  ```jsonc
  {
    "total": 2,
    "ok": 1,
    "failed": 1,
    "results": [
      { "index": 0, "ok": true, "result": { "id": "12:1" } },
      { "index": 1, "ok": false, "error": { "code": "INVALID_PARAMS", "message": "..." } }
    ]
  }
  ```
- **No hard cap.** Earlier tools capped batches at a fixed size (e.g. 50); this one streams, so 200+ ops work the same way, just over more chunks.
- **Nested batches are rejected** (`INVALID_PARAMS`) — a batch item cannot itself be `op: "batch"`.

```js
const ops = rows.map((r) => ({ op: "create", params: { type: "TEXT", parentId: list.id, characters: r.label } }));
const res = await figma.batch(ops);
console.log(`${res.ok}/${res.total} ok, ${res.failed} failed`);
res.results.forEach((r) => { if (!r.ok) console.error(`op ${r.index} failed:`, r.error?.message); });
```

---

## Session state

`figma_write` accepts an optional `sessionId`. Within one session, a persistent plain object `state` survives across separate `figma_write` calls — token maps (`state.tokens`, set by `setupTokens`), node id registries, or any other constant you want to avoid re-declaring:

```js
// call 1
await figma.setupTokens({ colors: { primary: "#2563EB" } });
state.rootId = (await figma.create({ type: "FRAME", name: "Screen", width: 390, height: 844 })).id;

// call 2 — same sessionId — state.rootId and state.tokens are still there
await figma.create({ type: "TEXT", parentId: state.rootId, characters: "Hi", wrap: true });
```

Omit `sessionId` to use the default session. `figma_status.sessions` lists a summary per active session. Sessions are process-local — they live on the leader (the process that owns the bridge/executor); a follower's `figma_write` calls are forwarded to the leader and execute against the leader's session state, so `sessionId` behaves consistently regardless of which MCP process (leader or follower) the client happens to be talking to.

---
