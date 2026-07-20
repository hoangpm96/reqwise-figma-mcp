export const API = `# figma_write proxy API

Inside \`figma_write({code})\` you have: \`figma\` (proxy), \`state\` (persistent
object), \`console\`, and standard JS globals. Every \`figma.*\` method returns a
Promise (one bridge round-trip). Modern ES is supported (\`?.\`, \`??\`, spread,
async/await, destructuring). Banned: require, process, fetch, setTimeout, eval.

This proxy is NOT the official Figma Plugin API — the method set differs
(no createFrame/appendChild/loadFontAsync; use create/parentId/fontName).
Calling an unknown method throws an error that names the sandbox equivalent.

## Colors
Everywhere a color is accepted (fills, strokes, gradient stops, effects,
overlay): \`"#rrggbb"\` / \`"#rrggbbaa"\` hex strings, or \`{r,g,b[,a]}\` objects
with channels 0..1 (the official Figma shape; 0..255 ints are auto-detected).
A malformed color THROWS — it is never silently replaced.

## Creation & mutation
- \`create(spec)\` → new node. spec.type is FRAME/TEXT/RECTANGLE/... plus
  parentId, size, fills, and layout helpers (inset/align/insertAt/wrap).
  \`create(spec, parentId)\` also works, but prefer parentId inside the spec.
  OMITTING parentId puts the node at PAGE level — always parent screen
  content explicitly.
  FRAME/COMPONENT nodes are transparent when both \`fill\` and \`fills\` are
  omitted (Figma's default white fill is cleared), so structural wrappers do
  not become accidental white slabs. Declare a fill for visible surfaces.
  Padding accepts \`padding: 16\`, \`padding: {left, right, top, bottom}\`, or
  flat \`paddingLeft\`/\`paddingRight\`/\`paddingTop\`/\`paddingBottom\`.
  Radius accepts \`cornerRadius\` plus the common \`borderRadius\`/\`radius\`
  aliases and per-corner radius fields.
- \`modify(nodeId, props)\` → patch properties.
- \`delete(nodeId, {force})\` (alias \`del\`).
- \`clone(nodeId, {parentId, insertAt})\` → \`{id, childMap}\` mapping ORIGINAL
  child ids → CLONED child ids, so you edit the right descendant without
  name-search.
- \`move(nodeId, {x,y,parentId,insertAt})\`, \`resize(nodeId,{w,h})\`.
- \`group(nodeIds)\`, \`ungroup(nodeId)\`, \`flatten(nodeId)\`.
- \`batch(ops, {resultDetail?})\` — see recipes; streams in chunks with partial
  commit. \`resultDetail: "ids"\` trims each successful item to just its id
  (skip echoing a full node per item on large create batches).

## Components
- \`findComponent(query)\` fuzzy match across COMPONENT and COMPONENT_SET nodes
  (normalized name, set/variant /-path aware). Results expose type/path and a
  component set's defaultVariantId.
- \`findOrCreateComponent(name, spec, {dryRun, threshold})\` — reuse-first.
  Always returns \`decision: "reuse"|"create"\` + \`score\` + \`reason\`;
  \`dryRun: true\` decides without creating (create branch lists candidates).
- \`instantiate(componentIdOrName, {parentId, props, overrides})\` — pass a
  component id OR a name query ("Button/Primary"); names resolve via the same
  fuzzy match as findComponent (below-threshold → error listing candidates).
  Result carries \`resolved: {via: "id"|"query", score?}\`. Prefer \`props\`
  for Figma component properties; use layer-name \`overrides\` only as a fallback.
  Text overrides on layers wired to a component property are applied through
  setProperties (auto-layout reflows correctly); the result reports each one in
  \`overridesApplied: [{target, field, appliedVia: "property"|"name", ok}]\`.
- \`createVariants(baseSpec, variantsOrAxes)\` — real Figma component set.
  Multi-axis: pass \`{Size: ["sm","md"], State: ["default","hover"]}\` →
  Cartesian matrix ("Size=sm, State=hover", max 50 combos). Legacy single-axis
  list still works; object entries may add per-variant spec overrides
  (\`{name: "State=Hover", fills: [...]}\`).
- \`arrangeComponentSet(setId, {gap, padding, columnsBy})\` — grid the variants
  of a COMPONENT_SET: columns iterate \`columnsBy\` (default: last axis),
  rows iterate the remaining axis combinations; the set resizes to fit.
- \`setComponentDescription(id, "markdown text")\` (or
  \`{description, documentationLinks: [{uri}]}\`) — document a COMPONENT /
  COMPONENT_SET; empty string clears. get_component reads it back.
- \`getLibraryComponent(key)\` — import a component/set from a PUBLISHED
  shared library by key; returns the same rich shape as get_component
  (props + variants + anatomy = reconstruction spec). Instantiate the result
  via its id.
- \`detachInstance(idOrIds)\` / \`resetInstanceOverrides(idOrIds)\` — detach
  instance(s) into plain frames / reset instance(s) to the main component.
  Per-target try/catch; result lists ok/error per id.
- \`componentize(nodeId, {name, replaceCopies, scope})\` — turn a drawn tree
  into a COMPONENT in place and (default on) replace every structural copy
  (same type/name tree) on the page — or \`scope: "document"\` — with an
  instance at the same spot. Draw once, reuse everywhere.

## Tokens & variables
- \`setupTokens(tokensJson)\` — DTCG-ish {colors, numbers, strings} → Variables,
  idempotent, stored in \`state.tokens\`. Sets ALL modes explicitly.
- \`applyVariable(nodeId, field, tokenName)\`.
- Variable CRUD: \`createVariable(name, {value|valuesByMode, type?, collection?,
  description?})\` (type inferred from the value; \`value\` writes ALL modes,
  \`valuesByMode: {light: "#fff", dark: "#111"}\` targets/creates modes),
  \`updateVariable(nameOrId, {value|valuesByMode|description})\`,
  \`renameVariable(nameOrId, newName)\` (bindings follow the id — refs kept),
  \`deleteVariable(nameOrId, {replaceWith?, force?})\` — replace-gated: if the
  variable is still bound anywhere the delete fails and tells you the usage
  count; \`replaceWith\` rebinds every consumer first. Batch them via
  \`figma.batch([{op: "create_variable", params: {...}}, ...])\`.
- \`exportTokens({format: "dtcg"|"css"|"tailwind", collection?, mode?,
  allModes?})\` — variables → DTCG JSON (aliases as "{a.b}" refs; allModes
  keys by mode), CSS custom properties (non-default modes as
  \`[data-theme="mode"]\` blocks, aliases as var() refs), or a Tailwind theme
  extension (colors + spacing).
- \`importTokens(dtcgTree, {collection?, mode?})\` or
  \`importTokens({modes: {light: tree, dark: tree}})\` — upsert variables by
  name; missing modes are created; "{a.b}" aliases resolve after literals
  land; conflicts/unresolved aliases warn instead of failing.

## Text & assets
- \`setText(nodeId, content)\`.
- \`searchIcons(query)\` → candidate canonical names (no fetch).
- \`loadIcon(name, {library, size, color, parentId})\` — SVG fetched server-side,
  drawn by the plugin.
- \`loadImage(urlOrBase64)\`.

## Edit-in-place (composite ops)
These change existing nodes rather than drawing new ones. See the
"Edit-in-place lifecycle" in figma_docs(section="recipes").
- \`getInstanceOverrides(nodeId?)\` → the overrides of a component instance
  (defaults to the current selection). Pair with setInstanceOverrides.
- \`setInstanceOverrides(sourceId, targetIds)\` — format-painter: copy the
  overrides captured from \`sourceId\` onto every instance in \`targetIds\`
  (\`targetIds\` is a non-empty array). Both must be instances of the same
  component.
- \`setSelectionColors(nodeId, { from?, to, includeStrokes? })\` — recursively
  recolor a subtree: swap every fill matching \`from\` (hex; omit to replace ALL
  solid fills) to \`to\`. \`includeStrokes: true\` also recolors strokes. \`nodeId\`
  optional → current selection.
- \`setGradient(nodeId, { type, stops, transform?, target? })\` — paint a
  gradient. \`type\` ∈ LINEAR | RADIAL | ANGULAR | DIAMOND. \`stops\` is ≥2
  \`{ position: 0..1, color: "#rrggbb" | "#rrggbbaa" }\`. \`transform\` is the 2×3
  gradient matrix; omit it to use the default (LINEAR left→right:
  \`[[1,0,0],[0,1,0]]\`). \`target\` ∈ "fill" (default) | "stroke".
- \`setEffects(nodeId, effects)\` — replace a node's effects. Each effect is a
  shadow/blur object: \`{ type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" |
  "BACKGROUND_BLUR", color?: "#rrggbbaa", offset?: { x, y }, radius, spread? }\`.
  Shadows need \`color\`/\`offset\`/\`radius\` (\`spread\` optional); blurs need only
  \`radius\`.

## Reads (usable from write code too)
- \`getNode(id)\` (alias \`getNodeById\`) → a flat SNAPSHOT object
  ({id, name, type, x, y, w/width, h/height, fill, childCount, ...}), NOT a
  live node — mutate via modify(), not property assignment.
- \`getNodes(ids)\`, \`getChildren(id)\` → array of child snapshots.
- \`searchNodes({query, nodeId?, types?, limit?})\` — matches layer names AND
  text content; scoped under nodeId when given. Default \`limit\` is 50; when more
  matched, the result carries \`hasMore\`/\`totalMatched\` — narrow the query or
  raise \`limit\` rather than assuming the list is complete.
- \`getSelection()\`, \`getDocumentInfo()\`, \`getDesignContext({nodeId?, detail?,
  depth?})\` — a WHOLE-PAGE read (no nodeId) defaults to \`sparse\` because a page
  can be tens of thousands of tokens; pass a nodeId to deep-read one subtree, or
  detail:"compact"/"full" for more per-node data.
- \`readSelection({ detail?, depth? })\` — deep read of the CURRENT selection in
  one call (ids, types, bounds, text, fills). The entry point for editing what
  the user picked: readSelection → modify → layoutAudit.
- \`getStyles()\`, \`getVariables()\`, \`getComponents({detail:"design"})\`,
  \`getComponent(componentId)\`, \`getDesignSystemKit({depth?})\`, \`getFonts(families)\`.
- \`generateDesignMd({ depth?, screenDepth?, includeAnatomy?, includeScreens?,
  includeComponentUsage?, maxComponents?, maxScreens?, maxInstances?,
  maxVariantsPerComponent?, maxTextLayersPerComponent?, maxOutputChars? })\` —
  the durable spec of an existing Figma system: coverage, screen composition,
  observed usage, exact ids/keys/variants/property keys, token names, style refs
  and text layers. Call it before building UI from an existing system and save
  the markdown as \`design.md\`. Output limits omit whole sections rather than
  slicing Markdown. (See the "Reuse before create" rule in
  figma_docs(section="rules").)
- \`screenshot({nodeId, scale})\`, \`exportNode({nodeId, format})\`. PNG/JPG come
  back as a real image the model can SEE (an MCP image block), not a base64 text
  blob — so a screenshot is a genuine visual check, not a token sink. Still take
  ONE at the end, not repeatedly. SVG/PDF return as data.
- \`layoutAudit(nodeId)\` — structured verify.

## Misc
- \`currentPage()\`, \`createPage(name)\` (preflights plan limit → on failure
  returns \`{fallback:"current-page", reason}\`, never throws mid-flow), and
  \`setCurrentPage(pageId|{name})\` to switch the visible target page before
  selection/zoom operations.
- \`zoomToFit(nodeId)\`, \`overlay(spec)\`.
- \`listChannels()\` — connected Figma windows (server-answered, no plugin
  round-trip): \`[{channel, plugin:{fileName,pageName,...}, queueLength}]\`.

## Channels (multiple Figma windows)
Each Figma window running the plugin joins a **channel** (shown as a chip in
the plugin UI). With ONE window you never think about this — everything
auto-routes. With SEVERAL windows either:
- pass \`channel\` in the tool call: \`figma_write({code, channel})\`,
  \`figma_read({op, params, channel})\` — pick one via
  \`figma_read({op:"list_channels"})\`; or
- ask the user to click YOUR session in the plugin UI of the window they want
  ("AI agents connected" list). After that your ops route there by default and
  your next result carries a one-time warning naming the bound channel.
\`AMBIGUOUS_CHANNEL\` / \`CHANNEL_NOT_FOUND\` errors list the open channels in
their hint. Each channel has its own serial queue, so agents on different
windows run in parallel.

## Sessions
Each MCP connection (one Claude Code / Codex instance) gets a private session
automatically — \`state\` is NOT shared across agents unless you pass an
explicit shared \`sessionId\`. \`figma_status\` reports \`mySessionId\` and (if
the user paired you to a window) \`myBoundChannel\`.

## Errors
Every failure throws \`{code, message, hint}\`. Read \`hint\` — it names the next
concrete step (e.g. wrong nodeId, missing font, use overlay()).
`;
