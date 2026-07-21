# Tool Reference

Reqwise Figma MCP exposes exactly 5 MCP tools. This document is the full reference for each — parameters, every `figma_read` operation, the entire `figma.*` sandbox API used by `figma_write`, error codes, warnings, batch behavior, and session state.

- [Which tool, when](#which-tool-when)
- [`figma_status`](#figma_status)
- [`figma_read`](#figma_read)
- [`figma_write`](#figma_write)
- [`figma_rules`](#figma_rules)
- [`figma_docs`](#figma_docs)
- [Error codes](#error-codes)
- [Warnings](#warnings)
- [Batch streaming](#batch-streaming)
- [Session state](#session-state)

## Which tool, when

The five tools split by *intent* — diagnose, read, write, learn:

| You want to… | Call |
|---|---|
| Check the connection, or anything behaves oddly | `figma_status` — read `hints` first; it names the next concrete step. |
| Draw **in a file that has a design system** | `figma_rules` first (one-call rule sheet), so you bind existing variables/components instead of hardcoding hexes and lookalikes. |
| Produce a **durable spec** of an existing design system (for a codebase, or before a big build) | `figma_read` op `generate_design_md` → save as `design.md`. For structured JSON, `get_design_system_kit`. |
| See what's on the canvas | `figma_read`: `get_design_context` (page map — sparse by default, then drill into a `nodeId`), `read_selection` (what the user selected, deep), `search_nodes` (find by name/type/text), `get_node`/`get_nodes` (known ids). |
| Work with components | `get_components` (catalog) → `get_component` (one, rich) → `get_library_component` (from a published library). To create/reuse/instantiate: `figma_write` with `findOrCreateComponent` / `instantiate` / `componentize`. |
| Create or modify anything on the canvas | `figma_write` — one call can mix reads and writes; use `figma.batch()` for many sibling ops. |
| **Verify** what you just drew | `figma_read` op `layout_audit` (structural facts: overflow, clipping, truncation) — then `screenshot` once for human review. |
| Move tokens in/out of the file | `export_tokens` (read) / `importTokens`, `setupTokens` (write). |
| Learn the safe-default semantics, layout math, or recipes | `figma_docs` (`rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes`). |

The typical session: `figma_status` → `figma_rules` → `figma_write` (draw, reusing what the rule sheet showed) → `layout_audit` → fix → `screenshot` for the human.

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
  "serverVersion": "0.1.0",
  "protocolVersion": 3,
  "bridgeAuth": "ok",             // "ok" | "missing"
  "plugin": {
    "version": "0.1.0",
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
| `generate_design_md` | — (optional `depth`, `screenDepth`, `includeJson`, `includeAnatomy`, `includeScreens`, `includeComponentUsage`, `maxComponents`, `maxScreens`, `maxInstances`, `maxVariantsPerComponent`, `maxTextLayersPerComponent`, `maxOutputChars`) | Evidence-grounded Markdown spec: coverage, tokens/styles, observed screen/layout patterns, local/remote component usage, exact Figma ids/keys/props/variants, instantiate snippets, rules and known gaps. |
| `screenshot` | optional `nodeId`, `scale` | PNG returned as a real MCP **image block** the model can see (not a base64 text dump), so it counts as image tokens, not thousands of text tokens. `scale` defaults to `0.6` — tuned for cheap verification renders, not pixel-perfect export. |
| `export_node` | `nodeId` | Export as PNG/SVG/JPG/PDF (format passed in params). |
| `get_fonts` | families list | Availability check for a list of font families — use before assuming a font will render. |
| `export_tokens` | — (optional `format`, `collection`, `mode`) | Export Figma Variables as design tokens: `format: "dtcg"` (default) \| `"css"` \| `"tailwind"`. The write-side twin is `import_tokens` (two-way tokens). |
| `layout_audit` | `nodeId` | **The structured verify tool** — see below. |

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

---

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
| `create` | `create(spec)` | `spec.type` is `FRAME`/`TEXT`/`RECTANGLE`/etc, plus `parentId`, size, `fills`, and layout helpers (`inset`, `align`, `insertAt`, `wrap`). FRAME/COMPONENT without `fill`/`fills` defaults to transparent. Padding supports uniform/object/flat-side spellings; radius supports `cornerRadius`, `borderRadius`, `radius`, and per-corner fields. Returns the created node (with `id`). |
| `modify` | `modify(nodeId, props)` | Patch properties on an existing node. |
| `delete` (alias `del`) | `delete(nodeId, { force })` | Remove a node. |
| `clone` | `clone(nodeId, { parentId, insertAt })` | Returns `{ id, childMap }` — `childMap` maps **original** child ids to **cloned** child ids, so you can edit the right descendant of the clone without name-based search. |
| `move` | `move(nodeId, { x, y, parentId, insertAt })` | Reposition and/or reparent. |
| `resize` | `resize(nodeId, { w, h })` | |
| `group` | `group(nodeIds)` | |
| `ungroup` | `ungroup(nodeId)` | |
| `flatten` | `flatten(nodeId)` | |
| `batch` | `batch(ops, {resultDetail?})` | `ops: [{ op, params }, ...]`. `resultDetail: "ids"` trims each successful item's result to just its node id. See [Batch streaming](#batch-streaming). |

#### Edit-in-place (modify existing designs)

These package write/modify logic that has no single-property equivalent — the core of the "select something on the canvas and change it" workflow.

| Method | Signature | Notes |
|---|---|---|
| `readSelection` | `readSelection({ detail, depth })` | Deep-read whatever the user has selected in one call — the entry point for selection-first editing. Returns `{ count, nodes }`. |
| `setSelectionColors` | `setSelectionColors(nodeId?, { from?, to, includeStrokes? })` | Recursively recolor SOLID fills (and strokes unless disabled) across a subtree. If `from` (hex) is given, only that color is replaced. Returns `{ changed }`. Great for recoloring an existing icon/illustration. |
| `setGradient` | `setGradient(nodeId, { type, stops, transform?, target? })` | `type` is `LINEAR`/`RADIAL`/`ANGULAR`/`DIAMOND`; `stops: [{ position: 0..1, color, opacity? }]`. `transform` defaults to the identity matrix `[[1,0,0],[0,1,0]]` so you rarely need it. `target` is `fills` (default) or `strokes`. |
| `setEffects` | `setEffects(nodeId, effects)` | `effects: [{ type: "DROP_SHADOW"\|"INNER_SHADOW"\|"LAYER_BLUR"\|"BACKGROUND_BLUR", color?, offset?, radius, spread?, visible?, blendMode? }]`. Packages the shadow shape agents commonly get wrong. |
| `getInstanceOverrides` | `getInstanceOverrides(nodeId?)` | Read the override set from an instance (or the selected instance). |
| `setInstanceOverrides` | `setInstanceOverrides(sourceId, targetIds)` | "Format painter" for components: copy overrides from one instance onto many existing instances (swaps main component to match, re-applies text/fill/visibility). Returns `{ applied: [{ id, ok, error? }], okCount, failCount }`. |

`setText(nodeId, content)` is mixed-font-safe: on a text node with multiple fonts it loads every range's font before writing, so it won't crash on `figma.mixed`, and reports any font fallback that was applied.

```js
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, height: 200, layoutMode: "VERTICAL",
});
```

#### Components

| Method | Signature | Notes |
|---|---|---|
| `findComponent` | `findComponent(query)` | Fuzzy match across COMPONENT and COMPONENT_SET nodes; normalized name and set/variant paths (e.g. `"Button/State=Default"`). Results include type/path/defaultVariantId. |
| `findOrCreateComponent` | `findOrCreateComponent(name, spec, { dryRun?, threshold? })` | Reuse-first: returns `decision: "reuse" \| "create"` plus `score` and `reason` so the choice is transparent. `dryRun: true` reports the decision without creating anything; `threshold` tunes match strictness. |
| `instantiate` | `instantiate(componentIdOrName, { parentId, props, overrides })` | Creates an instance. Accepts a **name or query** too (same fuzzy match; a COMPONENT_SET resolves to its default variant). Prefer `props` for Figma component properties; text overrides wired to a component property go through `setProperties` so auto-layout reflows — each override reports `appliedVia: "property" \| "name"`. |
| `createVariants` | `createVariants(baseSpec, variantsOrAxes)` | Array of per-variant specs, **or** a multi-axis matrix `{ Size: ["S","M"], State: ["Default","Hover"] }` (cap 50 combos) → a real Figma component set, not a flat group of look-alikes. |
| `arrangeComponentSet` | `arrangeComponentSet(setId, { gap, padding, columnsBy })` | Tidy a variant set into a readable grid; `columnsBy` groups columns by one variant axis. |
| `setComponentDescription` | `setComponentDescription(id, text \| { description, documentationLinks })` | Set the component description (and doc links) shown in Figma's inspector. |
| `getLibraryComponent` | `getLibraryComponent(key)` | Import + rich-read a component from a published shared library (see `get_library_component` above). |
| `detachInstance` | `detachInstance(idOrIds)` | Detach instance(s) from their main component. Batch-safe: per-target try/catch, reports per-id results. |
| `resetInstanceOverrides` | `resetInstanceOverrides(idOrIds)` | Reset override(s) back to the main component. Same batch-safe shape. |
| `componentize` | `componentize(nodeId, { name, replaceCopies?, scope? })` | Convert an already-drawn tree into a COMPONENT **in place**; structural copies (matched by a recursive type/name signature) are replaced with instances at their original positions. |

```js
const btn = await figma.findOrCreateComponent("Button/Primary", { type: "COMPONENT" /* spec */ });
await figma.instantiate(btn.id, {
  parentId: screen.id,
  props: { "Label#1:2": "Save", Size: "Large" },
  overrides: { Label: { text: "Save" } }, // fallback only
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
`figma.instantiate` example. For very large systems tune `maxComponents`,
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
| `importTokens` | `importTokens({ tokens \| dtcg \| modes })` | DTCG tree (or `{ modes: { light: tree, dark: tree } }`) → Figma Variables — the two-way twin of `exportTokens`. |

```js
await figma.setupTokens({
  colors: { primary: "#2563EB", surface: { light: "#FFFFFF", dark: "#0B0B0F" } },
  numbers: { "radius-md": 8 },
});
await figma.applyVariable(card.id, "fills", "surface");
```

After `setupTokens`, the session token map is available at `state.tokens` (name → value). Prefer `applyVariable` over re-writing a hex you already tokenized, so a single token edit re-themes everything.

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
| `wrap` | `true` (on `TEXT` create) | Sets `layoutAlign: STRETCH`, `textAutoResize: HEIGHT`, and a sane default `lineHeight` (~1.45× font size) when `lineHeight` is omitted; warns if the parent has no fixed width to wrap against. |
| `lineHeight` | number \| `"AUTO"` \| `"150%"` \| `{unit,value?}` | Text create/modify. Number → PIXELS. Explicit value wins over `wrap`'s default. |
| `letterSpacing` | number \| `"2%"` \| `{unit,value}` | Text create/modify. Number → PIXELS. |
| `textCase` | `"ORIGINAL" \| "UPPER" \| "LOWER" \| "TITLE" \| …` | Text create/modify. Invalid enum throws (never silent no-op). |
| `textDecoration` | `"NONE" \| "UNDERLINE" \| "STRIKETHROUGH"` | Text create/modify. |
| `paragraphSpacing` | number (px) | Text create/modify. |
| `insertAt` | `"top" \| "bottom" \| { above: nodeId } \| { below: nodeId } \| index` | Z-order control on `create`/`move` — don't rely on creation order. |

Auto-layout sizing: setting `layoutMode: "VERTICAL" | "HORIZONTAL"` turns a frame into an auto-layout. Under a fixed-size parent, the constrained axis defaults to `counterAxisSizingMode: "FIXED"` unless you explicitly override it — this default is what prevents silent overflow. Use `primaryAxisSizingMode`/`counterAxisSizingMode: "AUTO"` (hug) or `"FIXED"` deliberately, and `layoutAlign: "STRETCH"` to make a child fill the cross axis.

---

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

> Reuse the above before creating new nodes: figma.applyVariable for colors/numbers, figma.findOrCreateComponent for components.
```

If a read fails, its section prints `_Could not load: <message> (<hint>)_` rather than failing the whole call. Call this before drawing so the agent reuses existing tokens/components instead of hardcoding new ones.

---

## `figma_docs`

```json
{ "section": "rules" }
```

`section` must be one of: `rules`, `layout`, `api`, `tokens`, `icons`, `recipes`. Omitting `section` (or passing an unknown one) returns a short index listing the available sections instead of erroring. Each section is a concise markdown page written to teach the calling agent the safe-default semantics — the same "error messages teach the AI" philosophy applied to documentation.

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
| `COMPONENT_IN_USE` | A component/component-set operation conflicts with existing instances. | Inspect via `get_components`/`get_selection` before retrying the mutation. | ⚠️ Maybe |
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

**Contextual:**
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
