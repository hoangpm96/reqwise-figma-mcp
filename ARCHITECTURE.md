# Reqwise Figma MCP — Architecture

> MCP server that lets AI agents **read and draw** on the Figma canvas via a companion Figma plugin. Designed from the failure analysis of `figma-ui-mcp`, `figma-mcp-go`, and the market landscape (Framelink, cursor-talk-to-figma, claude-talk-to-figma, figma-console-mcp, Figma official Dev Mode MCP).

## Design goals

1. **Safe by default** — the server/plugin layer prevents the classic AI drawing mistakes (overflow, hidden overlays, unwrapped text, clipped content, wrong z-order) instead of relying on prompt-layer discipline.
2. **Structured verification** — agents verify with data (bounds, clip flags), not only screenshots.
3. **Session-stateful** — design tokens and variable maps are set up once per session, not re-declared per call.
4. **Resilient connection** — WebSocket + heartbeat + auto-reconnect + leader/follower for multi-window; `figma_status` returns actionable diagnostics, never just a boolean.
5. **Compatible** — tool names (`figma_status`, `figma_read`, `figma_write`, `figma_rules`, `figma_docs`) are a superset of `figma-ui-mcp`, so existing orchestration code and prompts that call these tools migrate with minimal changes.
6. **A drawing that remembers its model** — every diagram frame stores the model it was drawn from, so a diagram can be patched rather than re-authored, and the diagrams in a file can be checked against *each other* — the one thing text-to-image diagramming cannot do, because there every diagram is an island.

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
- **Local threat model**: the bridge binds `127.0.0.1` only. Same-OS-user processes that can read `$TMPDIR/reqwise-figma-mcp/leader-*.json` (mode `0600`) may call `/rpc` — that is how followers work. Unauthenticated `GET /health` is intentionally minimal (no channel/file names). Reclaiming a live WS channel requires the `resumeToken` from `assigned` (stops name-only hijacks). `loadImage` only fetches public `https` URLs.
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
| `figma_diagram` | Draw an activity diagram (with or without swimlanes), a sequence diagram, a state machine, an ERD, a userflow or a sitemap from a model the agent derived from the spec, and report the holes in that model. Six kinds behind one `type`, because a tool description is paid for in every session. Takes the arrays or the compact `text` form, draws a placed set from `diagrams: [...]`, and redraws a frame in place from `update` + `patch`. Each draw is cross-checked against the other diagrams on its page. |
| `figma_docs` | On-demand docs: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes` \| `style` \| `userflow` \| `activity` \| `erd` \| `sequence` \| `sitemap` \| `state`. |

### `figma_status` — diagnostics, not a boolean

Returns JSON: `{ pluginConnected, statusSource, statusError?, mode: "leader"|"follower", port, bridgeAuth: "ok"|"missing", plugin: {version, apiVersionMatch, fileName, pageName, editorType}, channels: [{channel, fileName, pageName, queueLength, lastHeartbeatMs, boundSessions?}], lastHeartbeatMs, queueLength, pendingCount, sessions: [...], mySessionId, myBoundChannel?, hints: [...] }`.

**Plugin state on a follower is measured, not guessed.** A follower holds no bridge, so it forwards a synthetic `__status__` op over `/rpc` (short 2 s timeout — a diagnostic must not inherit the 130 s drawing-op timeout) and reports whatever the leader actually sees. `statusSource` says where the numbers came from: `"local"` (own bridge), `"leader"` (read over `/rpc`), or `"unknown"`.

`pluginConnected` is therefore **tri-state**: `true`/`false` are measured; `null` means the leader could not be queried. `lastHeartbeatMs` and `channels` are likewise `null` when unknown, never `-1`/`[]`. This distinction is load-bearing: the follower branch used to hardcode `pluginConnected:false`, and clients that gate on it walked users through plugin restarts while the plugin was connected and writing normally. Never collapse "no data" into `false`.
`hints` is an ordered list of concrete next steps when something is off (e.g. "Plugin version 1.x < server 2.x — reinstall plugin from plugin/manifest.json", "No heartbeat for 30s — the Figma window may be minimized", "2 Figma windows are connected — pass channel or ask the user to pick this session in the plugin UI").

### `figma_read` operations


At `design` detail, paints/effects/typography are compacted for token economy: a solid fill serializes as `{type:"SOLID", hex:"#101827"}` instead of raw full-precision float channels, Figma-default fields (`visible:true`, `opacity:1`, `blendMode:"NORMAL"`, AUTO line-height, zero letter-spacing, …) are omitted, and empty `strokes`/`effects` arrays are dropped.

**`layout_audit(nodeId)`** is the structured verify tool: walks the subtree and returns per-node `{id, name, declared: {x,y,w,h}, rendered: absoluteBoundingBox, overflowsParent: bool, clippedBy: parentId|null, textTruncated: bool, zIndexWarnings: [...], styleWarnings: [...]}` plus a summary `{issues, styleHints}`. Token-frugal by default: only records that carry a finding are returned (`nodeCount`/`reportedCount` make the filtering visible; `verbose: true` restores the full per-node dump). Agents call this after drawing instead of eyeballing screenshots; screenshots remain for final human review.



### `figma_write` — code execution model

- Payload `{ code, sessionId?, channel? }`. Code runs in `vm.createContext` with: `figma` proxy, `console` (captured), standard globals. Banned: `require/process/fetch/setTimeout/eval`. Node's vm supports full modern syntax (`?.`, `??`, spread) — no ES restrictions. `channel` pins the whole call to one Figma window (see Channel routing); omitted, it auto-routes.
- **Persistent session state**: `session.state` (a plain object) survives across `figma_write` calls in the same session — token maps, node id registries, constants. Exposed as global `state` in the sandbox. Sessions default to a per-process private id (see Sessions above).
- Every `figma.*` method is a Promise → one bridge round-trip, except `figma.batch(ops)` which ships N ops in one round-trip with **chunked streaming**: server splits into chunks of 20, plugin reports progress per chunk (resets timeout), per-item try/catch, partial results are committed (no rollback), response lists exactly which index failed and why. No hard cap: 200 ops are fine, they stream.

### Edit-in-place lifecycle (selection-first editing)

Reqwise supports two workflows, not just create-from-scratch:



### Per-connection write serialization

The Figma Plugin API races and times out when two mutations overlap. The leader's bridge dispatches operations to the plugin through a **single in-flight gate per plugin connection (per channel)** — at most one op is being executed by a given plugin window at a time; the rest queue FIFO on that channel. Different channels are different Figma windows (separate main threads), so they run **in parallel**. Per-op timeouts start at dispatch (dequeue), not while queued. `figma_status.queueLength`/`pendingCount` aggregate across channels; per-channel numbers are in `figma_status.channels[]`. This makes concurrent `figma_write` calls (multiple sub-agents, follower→leader forwards) safe without the caller having to coordinate.

### Proxy API (what the sandbox `figma.*` exposes)

Creation/mutation: `create(spec)`, `modify(nodeId, props)`, `delete(nodeId, {force})`, `clone(nodeId, {parentId, insertAt})` → **returns `{id, childMap}`** mapping original child ids → cloned child ids, `move`, `resize`, `group`, `ungroup`, `flatten`, `batch(ops)`.
Edit-in-place: `readSelection({detail, depth})` (deep-read the current selection), `setSelectionColors(nodeId?, {from?, to, includeStrokes?})` (recursive recolor), `setGradient(nodeId, {type, stops, transform?, target?})`, `setEffects(nodeId, effects[])`.
Tokens: `setupTokens(tokensJson)` (DTCG-ish `{colors, numbers, strings}` → Figma Variables; idempotent; stores map in `session.state.tokens`), `applyVariable(nodeId, field, tokenName)`, variable CRUD — `createVariable(name, {value|valuesByMode, type?, collection?})` (value → all modes explicitly), `updateVariable`, `renameVariable` (bindings follow the id), `deleteVariable(nameOrId, {replaceWith?, force?})` (replace-gated: scans document usages, rebinds via `replaceWith` before removal), `exportTokens({format: "dtcg"|"css"|"tailwind", mode?, allModes?})` / `importTokens(dtcgTree | {modes})` (two-way tokens; pure serialization in `shared/token-format.ts`).
Text/assets: `setText(nodeId, content)`, `loadIcon(name, {library, size, color, parentId})`, `searchIcons(query)` → candidates with canonical names (server-side alias map: material→ionicons→lucide synonyms; results cached on disk), `loadImage(url|base64)`.
Userflow: `userflow(spec)` — the agent supplies the graph (screens, happy path, error and edge cases, or a `mermaid` source); the SERVER lays it out (dagre + one-port-per-edge orthogonal routing, return edges in outer gutters) and the plugin only draws it, the same split as `loadIcon`. Returns the flow-id → node-id map plus `warnings` about the graph's shape (a decision with one way out, a dead end, an unreachable node, a screen with no `screenId`). `create` in turn warns when a page-level screen is drawn while the page has no userflow, or has one that does not contain it — so the agent asks the user instead of quietly letting flow and design drift apart.

The other five kinds share that split and most of that code. `src/shared/diagram/` holds what every diagram needs (text metrics, the (along, cross) axis projection, the palette, arrow emission, graph checks); each kind adds only what is genuinely its own — lane-constrained placement for an activity, columns and rows for a sequence, — and `src/plugin/diagram-reflow.ts` is the one door the live watcher and the `reflow_diagram` op come through, so adding a kind means adding it in one place rather than teaching every caller a new marker.

The orthogonal router in `src/shared/activity/route.ts` is the shared one: it is a pure function of WHERE THE BOXES ARE, with no dagre in it, so re-running it over canvas positions reproduces the layout exactly and needs no stored waypoints. With `lanes: []` it is simply a graph router, which is why the state machine gets self-loops, branch spreading and hand-dragged connection points for almost no new code. What each kind tunes is which compromises it will accept: an activity sends an unroutable arrow around the outside of every lane, because cutting back across three lanes is unreadable; a use case diagram forbids that gutter and threads between two rows instead, because there an association that crosses another line is normal and a detour around the whole picture reads as a mistake.

Every kind is a **proof-reader first**. The checkers report the model, not the drawing — a use case nobody can start, two state transitions racing on one event, a call nobody answers — and the use case checker goes further and drops a link UML has no meaning for, because a diagram that shows one is lying. The bar, learned by shipping a checker that cried wolf: a proof-reader is only worth having if it is silent when the model is right, so every rule carries the exemption that makes its silence deliberate.

**The frame stores the model it was drawn from**, and that one decision is what the rest of the diagram layer is built on. It buys three things no text-to-image diagram tool can offer:

- **Patching instead of re-authoring.** `figma_read get_diagram_spec` hands the model back, and `figma_diagram { update, patch }` changes it in place — the frame keeps its id, so comments, prototype links and wherever the user dragged it all survive. `src/server/patch.ts` is deliberately kind-agnostic: a collection is just an array on the spec, so `messages`, `entities`, `transitions` and `links` all work without that module knowing what any of them mean. A patch may only produce a spec — the rebuild and the checker then run exactly as they would on a fresh call, so there is no path that skips proof-reading. On the ticket-booking set, 73% of the JSON an agent emitted was spec it had already emitted once; that number is what this measures.
- **Asking whether the diagrams agree with each other.** Every checker above reads ONE model. The mistake none of them can see is two views of the same business that are each perfectly well-formed and say different things — the sequence retries three times and the state machine guards on `n < 5`; the ERD stores `cancelled` and the lifecycle cannot reach it. `src/shared/model/facts.ts` reads the models back off the frames (`get_page_model`) and answers only two questions per kind — who appears, and what values an entity can hold — so a seventh kind costs one `case`, not a redesign; `check.ts` compares them. The findings are advisory and never block a draw, because a page mid-way through being drawn is *supposed* to disagree with itself.
- **A business rule that cannot drift.** `options.policies` holds the numbers (`{"hold-minutes": 10}`) and labels reference them (`"Giữ ghế @hold-minutes phút"`). Substitution happens on the way to the LAYOUT, never on the way to the model, so the reference survives into what the frame stores: the page can be asked which frames depend on `hold-minutes`, and two diagrams quoting one rule differently is a finding rather than a thing nobody notices.

Since a frame remembers its model, a Figma file is already a machine-readable record of everything anybody has drawn in it — no glossary to maintain by hand, and no dependence on one chat session remembering what another one did last week.

Figma Design has no connector node (`figma.createConnector()` is FigJam-only), so the arrows are plain vectors and something has to move them when a box moves. The orthogonal router therefore lives in `src/shared/userflow/route.ts`, free of dagre, and runs in BOTH places: on the server after dagre has placed the ranks, and in the plugin — from a `PageNode.on("nodechange")` listener — with the box positions read straight off the canvas. The drawn frame stores its own graph in plugin data, which is what makes the second pass possible; `reflow_diagram` is the same pass on demand, for a flow rearranged while the plugin was closed. A reflow re-routes lines only: re-running the layout would undo the drag it is answering.
Misc: `getNodeById`, `getChildren`, `currentPage()`, `createPage(name)` (preflights plan limit; on failure returns `{fallback: "current-page", reason}` instead of throwing mid-flow), `zoomToFit(nodeId)`, `overlay(spec)`.

### Safe defaults & validations (the 15 root-cause fixes)

Implemented in **plugin handlers** (single source of truth), documented in `figma_docs`:

1. **Sizing**: a child auto-layout frame under a fixed-size parent defaults to `counterAxisSizingMode: FIXED` on the constrained axis unless explicitly set. Creating a node whose `x + w > parent.w` (or y/h) while parent `clipsContent` → operation succeeds but response carries `warnings: ["will be clipped …"]`.
2. **Overlay**: `figma.overlay({color, opacity, parentId})` creates a RECTANGLE (never a FRAME) sized to parent, inserted at the right layer. Passing `opacity < 1` on a FRAME create emits a warning ("opacity applies to entire subtree — use overlay()").
3. **Text wrap**: `create({type:"TEXT", wrap:true, …})` sets `layoutAlign: STRETCH` + `textAutoResize: HEIGHT` + default `lineHeight` (≈1.45 × fontSize) and verifies parent has a fixed width (else warning).
4. **Relative layout**: `inset: {left, right, top, bottom}` and `align: "center-x"|"center-y"|"center"` on create — plugin computes x/y/w/h from parent, no manual math.
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
- **Audit the node builder that cannot use the shared one, first.** Almost everything that
  creates a node goes through `createTree`, which applies the whole pipeline — geometry,
  paints, text, tokens, and the keys `create()` knows. A handful of things cannot: SVG has no
  node type, so an avatar or an icon must go through `figma.createNodeFromSvg`, and variants
  must go through `figma.combineAsVariants`. Every bypass found so far has carried the same
  defect, and it is not the obvious one. The node is not missing a value — it is wearing a
  value **some other code picked**: an 88.91px group inside the 88px clipping frame the SVG
  import returns, `cornerRadius: 5` on the set `combineAsVariants` creates. Nothing in the
  generator chose either, nothing in the generator can see either, and `layout_audit` /
  as false positives right up until somebody checks. Two independent finds (an SVG import's clipping group,\n  a component set's corner radius) and in both cases the bypass list was two entries long, so the
  check is cheap: grep the handler for `figma.create*` / `figma.combine*`, and look at what
  came back with defaults nobody asked for.
- **Both halves go stale independently, and the symptom is identical.** The server process
  loads `dist/server/index.js` once at startup and the plugin keeps the `plugin/code.js` it
  was launched with, so after `npm run build` there are four possible states and all four look
  like "I fixed it and nothing changed". The cycle is: build → restart the MCP server (a
  reconnect in the client) → re-run the plugin from Figma's Plugins → Development → then draw.
  A reconnect rotates the bridge channel, so a new channel id is NOT evidence that the plugin
  restarted. When a new op comes back `UNSUPPORTED_OPERATION`, the hint discriminates: it
  lists `list_channels` when the SERVER's operation set is old, and omits it when the PLUGIN's
  handler registry is.
