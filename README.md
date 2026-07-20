# Reqwise Figma MCP

**An MCP server that lets AI agents read and draw on the Figma canvas — safely.**

Reqwise Figma MCP pairs a local MCP server with a companion Figma plugin. Point Claude Code, Cursor, or any MCP-capable agent at it, and the agent can inspect a Figma file and draw into it by executing JavaScript against a `figma.*` proxy API — with the plugin layer catching the mistakes that usually turn "AI draws a screen" into "AI draws an overflowing, half-clipped mess."

It exists because the current generation of Figma MCPs make agents responsible for discipline they don't have: remembering never to overlay a semi-transparent frame, re-declaring token maps every call, manually computing x/y offsets, eyeballing screenshots to check for clipping. Reqwise moves that discipline into the server and plugin, and gives the agent a structured way to verify its own work.

## Why this one

| | Typical Figma MCP | Reqwise Figma MCP |
|---|---|---|
| Verification | Screenshot only — agent eyeballs pixels | `layout_audit` returns declared vs. rendered bounds, `overflowsParent`, `clippedBy`, `textTruncated` per node; screenshots stay for final human review |
| Overlays / scrims | Agent dims a screen with an opacity'd FRAME (dims the whole subtree) | `figma.overlay()` creates a correctly layered RECTANGLE — the mistake is structurally unavailable |
| Session state | Token maps and id registries re-declared every call | `state` is a persistent object per session; set up tokens once, reuse across calls |
| Connection | Silent boolean, or a dead WS with no explanation | `figma_status` returns diagnostics plus an ordered `hints` list of concrete next steps |
| Multiple IDE windows | Second server instance fights for the port or silently fails | Leader/follower election; followers forward through an authenticated `/rpc` to the one leader holding the plugin connection |
| Batch operations | Hard caps (e.g. 50 ops) with all-or-nothing failure | Chunked streaming, partial commit, exact per-index error reporting, no hard cap |
| Structural frames | Figma's default white fill turns layout wrappers into accidental white slabs | FRAME/COMPONENT without an explicit fill defaults to transparent; visible surfaces opt in |
| Sandbox JS | Restricted/older syntax (no `?.`, `??`, spread) | Node `vm` — full modern ES (optional chaining, nullish coalescing, spread, async/await) |
| Errors | Bare exceptions | Every failure carries `{code, message, hint}` — the hint is the next concrete step |
| Edit-in-place | Draw-from-scratch focus; per-op fights the single-threaded plugin | Selection-first workflow (`readSelection` → modify → `layout_audit`), instance-override "format painter", recursive recolor, mixed-font-safe text edits; writes serialized per connection so mutations never race |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design rationale and the root-cause fixes behind these defaults.

## Quickstart

**1. Install**

```bash
git clone https://github.com/<you>/reqwise-figma-mcp.git
cd reqwise-figma-mcp
npm install
npm run build
```

This builds the server to `dist/` and the plugin bundle to `plugin/code.js`.

**2. Register the MCP server**

```bash
claude mcp add reqwise-figma -- node /absolute/path/to/reqwise-figma-mcp/dist/server/index.js
```

(See [`docs/INSTALL.md`](./docs/INSTALL.md) for Cursor and Claude Desktop JSON config, plus `npx`-based setups.)

**3. Import the plugin into Figma Desktop**

Figma Desktop → menu → **Plugins → Development → Import plugin from manifest…** → select `plugin/manifest.json` from this repo. Run it from **Plugins → Development → Reqwise Figma MCP** and keep its window open.

**4. Check the connection**

Ask your agent to call `figma_status`. A healthy connection looks like:

```json
{
  "pluginConnected": true,
  "mode": "leader",
  "port": 38470,
  "plugin": { "version": "0.1.0", "apiVersionMatch": true, "fileName": "My File", "pageName": "Page 1" },
  "hints": ["All systems nominal. Draw with figma_write; verify with figma_read layout_audit."]
}
```

If `pluginConnected` is `false` or a hint mentions a version mismatch or missing heartbeat, see the troubleshooting table in [`docs/INSTALL.md`](./docs/INSTALL.md).

## Tools

| Tool | Purpose |
|---|---|
| `figma_status` | Rich connection diagnostics — plugin connection, leader/follower mode, heartbeat, queue, sessions, and an ordered `hints` list. Never a bare boolean. |
| `figma_read` | Read the canvas via an `op` enum (`get_document_info`, `get_selection`, `read_selection`, `get_design_context`, `get_design_system_kit`, `generate_design_md`, `search_nodes`, `screenshot`, `layout_audit`, ...) with token-frugal responses. |
| `figma_write` | Execute modern-ES JavaScript against the `figma.*` proxy to create/modify the canvas. `state` persists per session. |
| `figma_rules` | One-call design-system rule sheet (styles + variables + components) as markdown — read before drawing so you reuse instead of hardcode. For a durable spec, use `figma_read` op `generate_design_md` and save the returned markdown as `design.md`. |
| `figma_docs` | On-demand documentation: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes`. |

Full parameter reference for every operation and every `figma.*` method: [`docs/TOOLS.md`](./docs/TOOLS.md).

## Example: `figma_write`

```js
// Set tokens once — they persist in this session's `state.tokens`.
await figma.setupTokens({
  colors: { primary: "#2563EB", surface: "#0B0B0F" },
  numbers: { "radius-md": 8 },
});

// Draw a card with wrapping text, reusing the parent's width.
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, layoutMode: "VERTICAL",
});
await figma.applyVariable(card.id, "fills", "surface");
await figma.create({
  type: "TEXT", parentId: card.id, wrap: true,
  characters: "A long paragraph that must wrap inside the card.",
});

// Verify before screenshotting for a human.
const audit = await figma.layoutAudit(card.id);
if (audit.summary.issues.length) console.warn(audit.summary.issues);
```

## Example: generate `design.md`

Ask your agent to call:

```json
{ "op": "generate_design_md", "params": { "depth": 3, "includeAnatomy": true, "includeScreens": true } }
```

The response contains a source-grounded `design.md`: extraction coverage, colors,
typography, observed layout frequencies, screen composition evidence, local and
remote component usage, exact node ids/keys/variant ids/property keys, ready-to-run
instantiate examples, reuse rules, responsive evidence and known gaps. Save
it in the target codebase before asking the agent to create UI from an existing
Figma component system. Facts are separated from observations and unknown UX
semantics. For a very large file, tune `maxComponents`, `maxScreens`,
`maxInstances` or `maxOutputChars`; output limits omit complete sections rather
than cutting Markdown mid-table/code-block.

## Architecture

```
MCP client (Claude Code / Cursor)
      │ stdio (MCP)
      ▼
 Reqwise MCP server (Node ≥ 18, TypeScript)
      │  owns HTTP+WS server on localhost:38470 (fallback +1..+9)
      │    GET  /health    → diagnostics JSON
      │    POST /rpc       → follower → leader forwarding (auth token)
      │    WS   /ws        → Figma plugin UI connection
      ▼
 Figma Desktop plugin
   ├── ui.html   (WebSocket client, heartbeat, reconnect w/ backoff)
   └── code.js   (Plugin API executor, safe-default handlers)
```

Every operation — leader-direct or follower-forwarded — passes through one `validateOperation()` choke point before it reaches the plugin. Full topology, the leader/follower protocol, and the 15 safe-default fixes are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Documentation

- [`docs/INSTALL.md`](./docs/INSTALL.md) — detailed setup, MCP client configs, troubleshooting
- [`docs/TOOLS.md`](./docs/TOOLS.md) — full tool + `figma.*` API reference, error codes
- [`docs/MIGRATION.md`](./docs/MIGRATION.md) — migrating from `figma-ui-mcp`
- [`docs/RECIPES.md`](./docs/RECIPES.md) — practical cookbook
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design goals and internals

## License

MIT © 2026 Hoang Phan. See [`LICENSE`](./LICENSE).
