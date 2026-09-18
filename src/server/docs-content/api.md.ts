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
  A node that lands on the page (or a section) never covers existing work:
  if it overlaps anything — no x/y, or a guessed x/y — it keeps its x and is
  MOVED down until clear, with a warning saying where. Nodes of ONE
  figma_write call move together, so a row of screens stays a row.
  \`allowOverlap: true\` lays it on top on purpose. Same for clone/instantiate.
  FRAME/COMPONENT nodes are transparent when both \`fill\` and \`fills\` are
  omitted (Figma's default white fill is cleared), so structural wrappers do
  not become accidental white slabs. Declare a fill for visible surfaces.
  Padding accepts \`padding: 16\`, \`padding: {left, right, top, bottom}\`, or
  flat \`paddingLeft\`/\`paddingRight\`/\`paddingTop\`/\`paddingBottom\`.
  Radius accepts \`cornerRadius\` plus the common \`borderRadius\`/\`radius\`
  aliases and per-corner radius fields.
  \`children: [spec, ...]\` builds a whole subtree in ONE call — each entry is a
  full create spec (its own type/fills/tokens/textStyle/children), parented to
  the node being created, in array order (index 0 = bottom of the z-stack). This
  is the reliable way to lay out a screen: declare the tree once instead of
  appending node-by-node. (INSTANCE children aren't supported inside \`children\` —
  instantiate components, then \`move\` them into the built frame.)
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
- \`getLibraryComponent(key)\` — import a component/set from a PUBLISHED
  shared library by key; returns the same rich shape as get_component
  (props + variants + anatomy = reconstruction spec). Instantiate the result
  via its id.

## Tokens & variables
- \`setupTokens(tokensJson)\` — DTCG-ish {colors, numbers, strings} → Variables,
  idempotent, stored in \`state.tokens\`. Sets ALL modes explicitly.
- \`setupTextStyles(styles)\` — typography ramp → LOCAL text styles, upserted by
  name (idempotent, like setupTokens). Each entry: \`{ name, fontSize,
  fontFamily?, weight? (100–900) | fontStyle? ("Medium"), lineHeight?
  (px | "150%" | "auto"), letterSpacing?, description? }\`. Fonts resolve
  through the fallback chain; substitutions come back as warnings.
- \`setTextStyle(nodeId, styleNameOrId)\` — apply a local text style to a TEXT
  node; a miss throws listing candidate names.
- \`setupEffectStyles(styles)\` — elevation ramp → LOCAL effect styles, upserted
  by name (idempotent). Each entry: \`{ name, effects:[<shadow|blur>...],
  description? }\` where each effect is the same shape as create({effects}):
  \`{type:"DROP_SHADOW", color:"#rrggbbaa", offset:{x,y}, radius, spread?}\` or
  \`{type:"LAYER_BLUR", radius}\`. This is what makes elevation TOKENIZABLE —
  define \`elevation/card\`, \`elevation/overlay\` once, reuse everywhere. Prefer
  layered, low-alpha, ink-tinted shadows over one harsh black shadow; see
  figma_docs(section="style"). Apply with setEffects or by binding the style.
- \`applyVariable(nodeId, field, tokenName)\` — friendly fields expand:
  \`fill\`→fills, \`cornerRadius\`→all four corners, \`padding\`→all four paddings.
- **Create-time binding (prefer this over hex-then-bind):** in a create spec,
  \`fill: "$color/primary/500"\` / \`stroke: "$..."\` bind that variable as the
  paint, \`textStyle: "Title 02"\` applies a text style to a TEXT node, and
  \`tokens: { cornerRadius: "radius/md", padding: "space/4" }\` binds any other
  field — one call, no follow-up applyVariable. Unknown token/style names throw
  BEFORE the node is created.
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

## Userflow
- \`userflow(spec)\` — draw a userflow: screen boxes, decision diamonds,
  labelled arrows, dashed return paths in side gutters. The GRAPH is your own
  analysis of the spec (\`nodes\`/\`edges\`, or a \`mermaid\` source); layout,
  routing and the graph proof-read are the tool's. Returns
  \`{ frameId, nodes: {flowId: figmaNodeId}, warnings, stats }\`, where
  \`warnings\` names the holes in the flow (a decision with one way out, a dead
  end, an unreachable node, a screen with no screenId). Ask the user whether to
  map the flow BEFORE drawing screens. Full reference:
  figma_docs(section="userflow"). Also available as \`figma_diagram\` \`type:"userflow"\`
  tool.
- \`reflowDiagram({ frameId? })\` — put a drawn diagram's arrows back on its
  boxes after somebody rearranged them (userflow or activity). While the plugin is open this happens
  by itself on every drag (Figma Design has no connector node, so the plugin
  re-routes the vectors); this op is the same pass on demand, for a flow moved
  with the plugin closed. Omit \`frameId\` for every userflow on the page. It
  re-routes the LINES only — the boxes stay where the user put them. An arrow
  somebody moved BY HAND is left alone and reported as \`pinned\`;
  \`{ force: true }\` re-routes those too. To steer a connection point without
  giving up the following, pass \`fromAt\`/\`toAt\` (0..1) on the edge instead.

## Drawing primitives worth knowing
- \`create({type:"VECTOR", points:[[x,y],...], closed?})\` — a polyline (or a
  filled shape with \`closed:true\`) in PARENT coordinates; the plugin
  normalizes it into a local path plus x/y. Raw \`vectorPaths\` still work.
- \`create({type:"POLYGON", pointCount:4, ...})\` — pointCount 4 is a diamond,
  3 a triangle. \`STAR\` takes \`pointCount\` + \`innerRadius\`.
- \`strokeCap\` (\`"ARROW_LINES"\`, \`"ROUND"\`, …), \`strokeJoin\`,
  \`strokeAlign\`, \`dashPattern:[6,4]\` and \`rotation\` all apply on
  \`create\` — no second \`modify\` round-trip. A \`LINE\` honours \`w\`
  instead of keeping Figma's native 100px.

## Edit-in-place (composite ops)
These change existing nodes rather than drawing new ones. See the
"Edit-in-place lifecycle" in figma_docs(section="recipes").
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
- \`setReactions(nodeId, reactions)\` — replace a node's prototype reactions
  (click-through wiring). Each reaction: \`{ trigger: { type: "ON_CLICK" |
  "ON_HOVER" | "AFTER_TIMEOUT" | ... }, action: { type: "NODE", destinationId,
  navigation?: "NAVIGATE" | "SWAP" | "OVERLAY", transition?,
  preserveScrollPosition? } }\` (also \`{ type: "BACK" | "CLOSE" }\` and
  \`{ type: "URL", url }\`). Omitted \`transition\` defaults to SMART_ANIMATE /
  EASE_IN_AND_OUT / 0.3s; pass \`transition: null\` for an instant jump.
  \`destinationId\` must be an existing node; \`[]\` clears all reactions. Example:
  \`setReactions(btn.id, [{ trigger: { type: "ON_CLICK" }, action: { type:
  "NODE", destinationId: frame.id, navigation: "NAVIGATE" } }])\`.
  \`trigger.timeout\` (AFTER_TIMEOUT) and \`trigger.delay\` (MOUSE_*) are in
  SECONDS, like transition duration — the plugin converts to Figma's ms.

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
- \`generateDesignMd(...)\` → \`{ markdown, fingerprint, extraction }\`. The
  markdown is the machine-generated design-kit file (save it as \`design-kit.md\`
  in the codebase, NOT hand-edited); its top carries a \`<!-- dsfp:… -->\`
  fingerprint of the DS shape.
- \`designFingerprint()\` → \`{ counts, hash }\` — a CHEAP shape hash of the current
  design system (token/style/component NAMES + counts), no full scan. At the
  start of a draw session, compare it to the \`dsfp:\` in the cached
  design-kit.md: if they differ the DS changed since the file was written —
  regenerate before trusting it. Renaming/adding/removing a token or component
  changes the hash; recolouring an existing token does not.
- \`generateDesignMd({ depth?, screenDepth?, includeAnatomy?, includeScreens?,
  includeComponentUsage?, maxComponents?, maxScreens?, maxInstances?,
  maxVariantsPerComponent?, maxTextLayersPerComponent?, maxOutputChars? })\` —
  the durable spec of an existing Figma system: coverage, screen composition,
  observed usage, exact ids/keys/variants/property keys, token names, style refs
  and text layers. Call it before building UI from an existing system and save
  the markdown as \`design-kit.md\`. Output limits omit whole sections rather than
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
- \`deletePage(idOrName, {force?})\` — refuses the last page; switches off the
  current page first. A page that still has layers throws CONFIRM_REQUIRED
  naming what is on it: show that to the user, and pass \`force: true\` only
  after they agree. (\`delete(pageId)\` does not remove pages.)

## Deleting components and styles
- \`delete(componentId, {force?})\` removes a COMPONENT / COMPONENT_SET. With
  instances it needs \`force: true\`; the instances stay and can "Restore
  component" (result: \`instancesLeft\`). Deleting the last variant deletes its
  set (\`componentSetDeleted\`). Library components are read-only.
- \`deleteStyle(nameOrId, {type?, replaceWith?, force?})\` — PAINT/TEXT/EFFECT/
  GRID, replace-gated like deleteVariable: a style still applied is refused
  with the layer count; \`replaceWith\` (same type) moves those layers first;
  \`force\` unlinks them (they keep their look). \`type\` settles a name two
  kinds share.
- \`deleteUnusedStyles({types?, keep?, confirm?})\` — ALWAYS two calls. Without
  \`confirm\` it deletes nothing and returns \`wouldDelete\` + \`confirmToken\`.
  STOP there: show the user the full list, ask explicitly (AskUserQuestion),
  and only on a clear yes call again with the SAME types/keep and
  \`confirm: confirmToken\`. Never confirm on your own. A changed file makes
  the token stale (CONFIRM_REQUIRED) — preview and ask again. Only this file
  is scanned; a published library's consumers elsewhere are invisible.
- \`zoomToFit(nodeId)\`, \`overlay(spec)\`.
- \`listChannels()\` — connected Figma windows (server-answered, no plugin
  round-trip): \`[{channel, plugin:{fileName,pageName,...}, queueLength}]\`.

## Channels (multiple Figma windows)
Each Figma window running the plugin joins a **channel**. With ONE window you never think about this. With SEVERAL, pass \`file\` (and \`page\` if the same file is open twice) — fuzzy names are fine, and the session remembers after the first call. Different files, and different pages that each have a window, run in parallel. Same page queues. A brand-new session with no hint follows the focused window (the one the user last clicked). Opaque \`channel\` ids still work. Do not ask the user to click Connect.
\`AMBIGUOUS_CHANNEL\` / \`CHANNEL_NOT_FOUND\` errors list the open files in their hint.

## Sessions
Each MCP connection (one Claude Code / Codex instance) gets a private session
automatically — \`state\` is NOT shared across agents unless you pass an
explicit shared \`sessionId\`. \`figma_status\` reports \`mySessionId\` and (if
the user paired you to a window) \`myBoundChannel\`.

## Errors
Every failure throws \`{code, message, hint}\`. Read \`hint\` — it names the next
concrete step (e.g. wrong nodeId, missing font, use overlay()).
`;
