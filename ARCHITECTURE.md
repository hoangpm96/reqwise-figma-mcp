# Reqwise Figma MCP — Architecture

> MCP server that lets AI agents **read and draw** on the Figma canvas via a companion Figma plugin. Designed from the failure analysis of `figma-ui-mcp`, `figma-mcp-go`, and the market landscape (Framelink, cursor-talk-to-figma, claude-talk-to-figma, figma-console-mcp, Figma official Dev Mode MCP).

## Design goals

1. **Safe by default** — the server/plugin layer prevents the classic AI drawing mistakes (overflow, hidden overlays, unwrapped text, clipped content, wrong z-order) instead of relying on prompt-layer discipline.
2. **Structured verification** — agents verify with data (bounds, clip flags), not only screenshots.
3. **Session-stateful** — design tokens and variable maps are set up once per session, not re-declared per call.
4. **Resilient connection** — WebSocket + heartbeat + auto-reconnect + leader/follower for multi-window; `figma_status` returns actionable diagnostics, never just a boolean.
5. **Compatible** — tool names (`figma_status`, `figma_read`, `figma_write`, `figma_rules`, `figma_docs`) are a superset of `figma-ui-mcp`, so existing orchestration code and prompts that call these tools migrate with minimal changes.

## Topology

```
MCP clients (N × Claude Code / Codex / Cursor — one server process each)
      │ stdio (MCP)
      ▼
 Reqwise MCP servers: 1 LEADER + N-1 followers (forward over /rpc)
      │  leader owns HTTP+WS server on localhost:38470 (fallback +9)
      │    GET  /health          → diagnostics JSON (channels included)
      │    POST /rpc             → follower → leader forwarding (auth token)
      │    WS   /ws              → Figma plugin connections, ONE PER CHANNEL
      ▼
 Figma Desktop plugin — MULTIPLE windows, each joined to its own channel
   ├── ui.html   (iframe: WS client, heartbeat, reconnect, channel chip +
   │              agent-session picker)
   └── code.js   (main thread: Plugin API executor, safe-default handlers,
                  channel persistence via clientStorage)
```

- **Leader/follower** (from `figma-mcp-go`): first server process binds the port → leader. Later processes (other IDE windows) detect `EADDRINUSE`, verify leader via `/health`, and forward all operations via `POST /rpc`. Auth: leader writes a random token to `$TMPDIR/reqwise-figma-mcp/leader-<port>.json` (`{port, token, pid, startedAt}`); followers read it and send `Authorization: Bearer <token>`. `/rpc` without valid token → 401; on 401 the follower re-reads the discovery file and retries once (leader restarted with a fresh token). Discovery is per-port so several legitimate leaders (custom `FIGMA_MCP_PORT` cohorts) never contend for one file; the legacy global `leader.json` is still written best-effort for old-version followers, deferring to a live incumbent on another port. Health monitor: followers poll `/health` every 3–5 s (jittered); on leader death, attempt takeover (each takeover gets a fresh bounded election-attempt budget). On start, a follower registers its session with the leader (synthetic `__register__` op) so the plugin UI picker lists it immediately.
- **Validation choke point**: every operation — leader-direct or follower-forwarded — passes through one `validateOperation()` before hitting the bridge (fixes the figma-mcp-go bypass bug).
- **WebSocket bridge, multi-channel**: each plugin window connects to `/ws` and joins a **channel** (requested in `hello`, or generated and confirmed with an `assigned` message). Connections live in a per-channel map — multiple Figma windows stay connected simultaneously. A new `hello` on an existing channel replaces only THAT channel's connection (same window reloading / user moving the channel); its pending requests fail fast with a clear error, other channels are untouched. The replaced window does not auto-rejoin its old channel (no tug-of-war) — it reconnects and gets a fresh one. Heartbeat ping/pong every 10 s per connection; plugin reconnects with backoff (0.5 s → 8 s cap) and re-joins its persisted channel.

### Channel routing (multi-window, multi-agent)

`dispatch(op, params, {channel?, sessionId?})` resolves the target window:

1. **Explicit `channel`** (tool arg on figma_write/figma_read/figma_rules) → that window, or `CHANNEL_NOT_FOUND` listing open channels.
2. **Session binding** — the user clicked an agent session in a plugin window's UI (`bind` message): that session's ops route to that window. The first routed result carries a one-time warning naming the bound channel so the agent LEARNS about the pairing without polling; `figma_status` reports it as `myBoundChannel`.
3. **Single window** → auto-route (the zero-config default; one window + N agents needs no channel anywhere).
4. **No window** → ops wait in an unrouted queue until the first window connects ("start the agent first, open Figma second").
5. **Several windows, none of the above** → `AMBIGUOUS_CHANNEL` whose hint lists `channel (fileName · pageName)` for self-correction.

The plugin UI shows: the window's channel chip (copy/change/join), and an **agent-session picker** ("AI agents connected — pick one to drive this window") fed by server pushes (`channels` message on every join/leave/bind + heartbeat piggyback). `figma_read {op:"list_channels"}` returns the same list to agents (server-answered; never a plugin round-trip).

### Sessions (multi-agent isolation)

Each MCP server process generates a private default sessionId (`s-xxxxxxxx`) for its one stdio client, so N parallel Claude Code / Codex instances get isolated vm `state` automatically — no more accidental sharing through the old global `"default"` session. Passing an explicit `sessionId` remains the opt-in for deliberate state sharing. `figma_status` reports `mySessionId`.

## MCP tool surface

| Tool | Purpose |
|---|---|
| `figma_status` | Rich diagnostics (see below). |
| `figma_read` | Read operations (enum), token-frugal responses. |
| `figma_write` | Execute modern-ES JS in a Node `vm` sandbox against the `figma.*` proxy API. |
| `figma_rules` | One-call design-system rule sheet: styles + variables + components, as markdown. |
| `figma_docs` | On-demand docs: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes`. |

### `figma_status` — diagnostics, not a boolean

Returns JSON: `{ pluginConnected, statusSource, statusError?, mode: "leader"|"follower", port, bridgeAuth: "ok"|"missing", plugin: {version, apiVersionMatch, fileName, pageName, editorType}, channels: [{channel, fileName, pageName, queueLength, lastHeartbeatMs, boundSessions?}], lastHeartbeatMs, queueLength, pendingCount, sessions: [...], mySessionId, myBoundChannel?, hints: [...] }`.

**Plugin state on a follower is measured, not guessed.** A follower holds no bridge, so it forwards a synthetic `__status__` op over `/rpc` (short 2 s timeout — a diagnostic must not inherit the 130 s drawing-op timeout) and reports whatever the leader actually sees. `statusSource` says where the numbers came from: `"local"` (own bridge), `"leader"` (read over `/rpc`), or `"unknown"`.

`pluginConnected` is therefore **tri-state**: `true`/`false` are measured; `null` means the leader could not be queried. `lastHeartbeatMs` and `channels` are likewise `null` when unknown, never `-1`/`[]`. This distinction is load-bearing: the follower branch used to hardcode `pluginConnected:false`, and clients that gate on it walked users through plugin restarts while the plugin was connected and writing normally. Never collapse "no data" into `false`.
`hints` is an ordered list of concrete next steps when something is off (e.g. "Plugin version 1.x < server 2.x — reinstall plugin from plugin/manifest.json", "No heartbeat for 30s — the Figma window may be minimized", "2 Figma windows are connected — pass channel or ask the user to pick this session in the plugin UI").

### `figma_read` operations

`get_document_info`, `get_selection`, `read_selection` (deep-read the current selection in one call — the selection-first editing entry point), `get_design_context` (depth-limited, `detail: sparse|compact|full|design`; sparse = id/name/type/x/y/w/h only; whole-page reads default to sparse, scoped reads to compact), `get_node`, `get_nodes`, `search_nodes` (capped at 50, `hasMore`/`totalMatched` when truncated), `scan_text_nodes`, `scan_nodes_by_types`, `get_styles`, `get_variables`, `get_components`, `get_component` (rich single-component read: property definitions, variants, text layers, anatomy), `get_library_component` (import by key from a published shared library; rich serialization doubles as a reconstruction spec), `get_design_system_kit` / `generate_design_md` (bounded whole-file design-system extraction with explicit coverage metadata), `export_tokens` (variables → DTCG/CSS/Tailwind), `screenshot` (real MCP image block, `scale` default 0.6 for verify), `export_node` (PNG/SVG/JPG/PDF), `get_fonts` (availability check for a list of families), **`layout_audit`**, `list_channels` (server-answered: connected Figma windows).

At `design` detail, paints/effects/typography are compacted for token economy: a solid fill serializes as `{type:"SOLID", hex:"#101827"}` instead of raw full-precision float channels, Figma-default fields (`visible:true`, `opacity:1`, `blendMode:"NORMAL"`, AUTO line-height, zero letter-spacing, …) are omitted, and empty `strokes`/`effects` arrays are dropped.

**`layout_audit(nodeId)`** is the structured verify tool: walks the subtree and returns per-node `{id, name, declared: {x,y,w,h}, rendered: absoluteBoundingBox, overflowsParent: bool, clippedBy: parentId|null, textTruncated: bool, zIndexWarnings: [...], styleWarnings: [...]}` plus a summary `{issues, styleHints}`. Token-frugal by default: only records that carry a finding are returned (`nodeCount`/`reportedCount` make the filtering visible; `verbose: true` restores the full per-node dump). Agents call this after drawing instead of eyeballing screenshots; screenshots remain for final human review.

### `figma_write` — code execution model

- Payload `{ code, sessionId?, channel? }`. Code runs in `vm.createContext` with: `figma` proxy, `console` (captured), standard globals. Banned: `require/process/fetch/setTimeout/eval`. Node's vm supports full modern syntax (`?.`, `??`, spread) — no ES restrictions. `channel` pins the whole call to one Figma window (see Channel routing); omitted, it auto-routes.
- **Persistent session state**: `session.state` (a plain object) survives across `figma_write` calls in the same session — token maps, node id registries, constants. Exposed as global `state` in the sandbox. Sessions default to a per-process private id (see Sessions above).
- Every `figma.*` method is a Promise → one bridge round-trip, except `figma.batch(ops)` which ships N ops in one round-trip with **chunked streaming**: server splits into chunks of 20, plugin reports progress per chunk (resets timeout), per-item try/catch, partial results are committed (no rollback), response lists exactly which index failed and why. No hard cap: 200 ops are fine, they stream.

### Edit-in-place lifecycle (selection-first editing)

Reqwise supports two workflows, not just create-from-scratch:

1. **Create-from-scratch**: `create`/`instantiate` with explicit `parentId` + `inset`/`align` → `layout_audit`.
2. **Edit-in-place**: `readSelection()` (deep-read whatever the user has selected on the canvas) → `modify`/`setGradient`/`setEffects`/`setSelectionColors`/`setInstanceOverrides` on those nodes → `layout_audit` → `setSelection`/`zoomToFit` so the user sees what changed.

Write handlers fall into two kinds. **Property-set** ops (`modify`) map 1:1 to Figma node properties. **Composite write handlers** carry business logic that has no single property equivalent — `setInstanceOverrides` (swap main + copy overrides across existing instances, the "format painter"), `setSelectionColors` (recursive recolor of a subtree), mixed-font-safe `setText` (load every range's font before writing), `setGradient`/`setEffects` (package the tricky gradientTransform matrix / shadow shape). These live as dedicated handlers in `src/plugin/handlers/`, not forced into `modify`.

### Per-connection write serialization

The Figma Plugin API races and times out when two mutations overlap. The leader's bridge dispatches operations to the plugin through a **single in-flight gate per plugin connection (per channel)** — at most one op is being executed by a given plugin window at a time; the rest queue FIFO on that channel. Different channels are different Figma windows (separate main threads), so they run **in parallel**. Per-op timeouts start at dispatch (dequeue), not while queued. `figma_status.queueLength`/`pendingCount` aggregate across channels; per-channel numbers are in `figma_status.channels[]`. This makes concurrent `figma_write` calls (multiple sub-agents, follower→leader forwards) safe without the caller having to coordinate.

### Proxy API (what the sandbox `figma.*` exposes)

Creation/mutation: `create(spec)`, `modify(nodeId, props)`, `delete(nodeId, {force})`, `clone(nodeId, {parentId, insertAt})` → **returns `{id, childMap}`** mapping original child ids → cloned child ids, `move`, `resize`, `group`, `ungroup`, `flatten`, `batch(ops)`.
Components: `findComponent(query)` (fuzzy: normalized name, `/`-path aware, alias table), `findOrCreateComponent(name, spec, {dryRun, threshold})` (returns `decision: reuse|create` + score + reason), `instantiate(componentIdOrName, {parentId, props, overrides})` (resolves names via the same fuzzy match; text overrides wired to a component property go through `setProperties` so auto-layout reflows — reported per-override as `appliedVia: property|name`), `createVariants(baseSpec, variantsOrAxes)` (multi-axis matrix `{Size: [...], State: [...]}` → real component set, max 50 combos), `arrangeComponentSet(setId, {gap, padding, columnsBy})` (variant grid), `setComponentDescription(id, text|{description, documentationLinks})`, `getInstanceOverrides(nodeId?)` / `setInstanceOverrides(sourceId, targetIds[])` (copy overrides from one existing instance onto many), `getLibraryComponent(key)` (import from a published shared library; rich serialization doubles as a reconstruction spec), `detachInstance(idOrIds)` / `resetInstanceOverrides(idOrIds)` (per-target try/catch batches), `componentize(nodeId, {name, replaceCopies, scope})` (drawn tree → COMPONENT in place; structural copies become instances).
Edit-in-place: `readSelection({detail, depth})` (deep-read the current selection), `setSelectionColors(nodeId?, {from?, to, includeStrokes?})` (recursive recolor), `setGradient(nodeId, {type, stops, transform?, target?})`, `setEffects(nodeId, effects[])`.
Tokens: `setupTokens(tokensJson)` (DTCG-ish `{colors, numbers, strings}` → Figma Variables; idempotent; stores map in `session.state.tokens`), `applyVariable(nodeId, field, tokenName)`, variable CRUD — `createVariable(name, {value|valuesByMode, type?, collection?})` (value → all modes explicitly), `updateVariable`, `renameVariable` (bindings follow the id), `deleteVariable(nameOrId, {replaceWith?, force?})` (replace-gated: scans document usages, rebinds via `replaceWith` before removal), `exportTokens({format: "dtcg"|"css"|"tailwind", mode?, allModes?})` / `importTokens(dtcgTree | {modes})` (two-way tokens; pure serialization in `shared/token-format.ts`).
Text/assets: `setText(nodeId, content)`, `loadIcon(name, {library, size, color, parentId})`, `searchIcons(query)` → candidates with canonical names (server-side alias map: material→ionicons→lucide synonyms; results cached on disk), `loadImage(url|base64)`.
Misc: `getNodeById`, `getChildren`, `currentPage()`, `createPage(name)` (preflights plan limit; on failure returns `{fallback: "current-page", reason}` instead of throwing mid-flow), `zoomToFit(nodeId)`, `overlay(spec)`.

### Safe defaults & validations (the 15 root-cause fixes)

Implemented in **plugin handlers** (single source of truth), documented in `figma_docs`:

1. **Sizing**: a child auto-layout frame under a fixed-size parent defaults to `counterAxisSizingMode: FIXED` on the constrained axis unless explicitly set. Creating a node whose `x + w > parent.w` (or y/h) while parent `clipsContent` → operation succeeds but response carries `warnings: ["will be clipped …"]`.
2. **Overlay**: `figma.overlay({color, opacity, parentId})` creates a RECTANGLE (never a FRAME) sized to parent, inserted at the right layer. Passing `opacity < 1` on a FRAME create emits a warning ("opacity applies to entire subtree — use overlay()").
3. **Text wrap**: `create({type:"TEXT", wrap:true, …})` sets `layoutAlign: STRETCH` + `textAutoResize: HEIGHT` + default `lineHeight` (≈1.45 × fontSize) and verifies parent has a fixed width (else warning).
4. **Relative layout**: `inset: {left, right, top, bottom}` and `align: "center-x"|"center-y"|"center"` on create — plugin computes x/y/w/h from parent, no manual math.
5. **Component reuse**: `findComponent` fuzzy-matches before any create; `findOrCreateComponent` makes reuse the default path.
6. **Variants/clone**: `clone` always available (native `node.clone()`), returns child id mapping so callers edit the right descendant without name-based search.
7. **Batch**: chunked streaming + partial commit, described above.
8. **Connection**: heartbeat + reconnect + handshake + rich `figma_status`.
9. **Verify**: `layout_audit` structured readback.
10. **Z-order**: `insertAt: "top"|"bottom"|{above|below: nodeId}|index` on create/move.
11. **Icons**: `searchIcons` + cross-library alias resolution + disk cache of fetched SVGs.
12. **Fonts**: every text create/modify preflights `listAvailableFontsAsync`; unavailable family resolves through fallback chain (requested → Inter → system) and the response reports `{requestedFont, resolvedFont, reason}` — never a cryptic crash, never a silent swap.
13. **Tokens**: `setupTokens` creates/updates Figma Variables and caches the token map into `state.tokens` (name → value) for reuse across `figma_write` calls in the session. Multi-mode variables set values for **all modes** explicitly (light/dark bug in figma-ui-mcp).
14. **Modern ES**: Node vm, no syntax bans.
15. **Page limit**: `createPage` preflight + graceful fallback.

## Shared protocol (`src/shared/protocol.ts`)

Single module imported by both server and plugin build:

- `BridgeRequest { id, op, params, chunk? }` / `BridgeResponse { id, ok, result?, error?: {code, message, hint?}, warnings?: string[], progress? }`
- `ErrorCode` enum: `NOT_CONNECTED`, `NODE_NOT_FOUND`, `FONT_UNAVAILABLE`, `INVALID_PARAMS`, `PLUGIN_TIMEOUT`, `QUEUE_FULL`, `PAGE_LIMIT`, `COMPONENT_IN_USE`, `UNAUTHORIZED`, `SANDBOX_ERROR`, `INTERNAL`.
- `OPERATIONS` const: the full op name list (read + write) — the executor proxy, validator, and plugin handler registry are all generated from this list so the three layers can never drift.
- Zod schemas per op for `validateOperation()` (server side only; plugin trusts validated input but still try/catches).

## Timeouts

Single table in `src/shared/protocol.ts` (`OP_TIMEOUTS`): default 30 s; `screenshot`/`export_node` 90 s; `batch` = 30 s per chunk (progress resets). vm timeout = sum-of-op budget capped at 120 s — the vm must never fire before an in-flight bridge op (inverse of the figma-ui-mcp bug).

## Repo layout

```
reqwise-figma-mcp/
├── src/
│   ├── server/          # MCP server: index.ts, bridge.ts, leader.ts, follower.ts,
│   │                    # executor.ts, session.ts, validate.ts, tools.ts, icons.ts,
│   │                    # errors.ts, paths.ts, version.ts, docs-content/*.md.ts
│   ├── plugin/          # main.ts, serialize.ts, layout-math.ts, fonts.ts, paints.ts,
│   │                    # structure-sig.ts, …, handlers/{read,write,create,components,
│   │                    # design-system,tokens,text,audit,assets,export,
│   │                    # instance-overrides,paint-edit,registry}.ts
│   └── shared/          # protocol.ts, design-system.ts, token-format.ts — imported by both
├── plugin/              # manifest.json, ui.html, code.js (built artifact)
├── scripts/build.mjs    # esbuild: server → dist/, plugin → plugin/code.js (target es2017, iife)
├── tests/               # vitest: server/ (executor, validate, tools, bridge, leader/follower),
│                        # plugin/ (handlers + pure units: layout math, color, serialize,
│                        # font fallback, structure-sig), shared/ (design-system, protocol)
└── docs/                # INSTALL.md, TOOLS.md, MIGRATION.md (from figma-ui-mcp), RECIPES.md
```

## Engineering rules

- TypeScript strict everywhere; `@figma/plugin-typings` for plugin code.
- One version number: `package.json` is the single source; server, `/health`, and plugin handshake all read it (build injects into plugin).
- Every error returned to the agent carries `code` + `message` + `hint` (the "error messages teach the AI" philosophy from figma-ui-mcp, made systematic).
- Tests run in CI before any release; `npm test` must exist and pass.
- No `lsof`/`kill -9` process management — stale leader detection is done via `/health` + token file staleness only.
- External fetches (icon CDNs) are cached under `$TMPDIR/reqwise-figma-mcp/cache/` and documented — the "localhost-only" claim applies to the Figma bridge, not icon/image loading.
