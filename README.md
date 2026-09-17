# Reqwise Figma MCP

**An MCP server that lets AI agents read and draw on the Figma canvas — safely.** Open source (MIT).

> **Need design systems, journey maps, personas, accessibility and responsive audits, or self-playing demos?**
> They are in **[Reqwise Figma MCP Pro →](https://ai4ba.com/figma-mcp)**. Compare the two editions [below](#free-vs-pro).

Reqwise Figma MCP pairs a local MCP server with a companion Figma plugin. Point Claude Code, Cursor, Codex or any MCP-capable agent at it, and the agent can inspect a Figma file and draw into it by executing JavaScript against a `figma.*` proxy API — with the plugin layer catching the mistakes that usually turn "AI draws a screen" into "AI draws an overflowing, half-clipped mess." It also draws the BA diagrams a spec needs — userflow, activity, sequence, ERD, sitemap, state machine — and proof-reads the model behind each one.

It exists because the current generation of Figma MCPs make agents responsible for discipline they don't have: remembering never to overlay a semi-transparent frame, re-declaring token maps every call, manually computing x/y offsets, eyeballing screenshots to check for clipping. Reqwise moves that discipline into the server and plugin, and gives the agent a structured way to verify its own work.

## Free vs Pro

<!-- features:begin -->
| Feature | Free | Pro |
|---|:---:|:---:|
| **Connection** | | |
| Figma bridge with rich diagnostics and next-step hints | ✅ | ✅ |
| Several Figma windows and several AI agents at once (leader/follower) | ✅ | ✅ |
| One launcher for Claude Code, Cursor and Codex | ✅ | ✅ |
| Hardened local bridge (sandboxed JS, authenticated forwarding) | ✅ | ✅ |
| Rule sheet and on-demand docs for the agent | ✅ | ✅ |
| **Read and draw on the canvas** | | |
| Read pages, layers, selection; screenshots and exports | ✅ | ✅ |
| Draw and edit frames, text, shapes; streaming batches | ✅ | ✅ |
| Layout audit — overflow, clipping, truncated text | ✅ | ✅ |
| New work never lands on top of existing work | ✅ | ✅ |
| Tokens and variables — create, bind, edit, import/export | ✅ | ✅ |
| Text styles and effect styles | ✅ | ✅ |
| Icons, images, overlays, gradients, recolor | ✅ | ✅ |
| Prototype reactions | ✅ | ✅ |
| Delete pages and styles, sweep unused styles | ✅ | ✅ |
| Read an existing design system; export design-kit.md | ✅ | ✅ |
| Components — find, create, variants, instances | — | ✅ |
| Component properties — booleans, nested instances, edit/delete | — | ✅ |
| Design-system compliance audit and auto-binding | — | ✅ |
| **BA diagrams** | | |
| Userflow | ✅ | ✅ |
| Activity diagram with swimlanes | ✅ | ✅ |
| Sequence diagram | ✅ | ✅ |
| ERD | ✅ | ✅ |
| Sitemap | ✅ | ✅ |
| State machine | ✅ | ✅ |
| Arrows follow the boxes; edit a diagram in place | ✅ | ✅ |
| Cross-check diagrams against each other | ✅ | ✅ |
| Use case diagram | — | ✅ |
| User journey map (several layouts and themes) | — | ✅ |
| Persona set | — | ✅ |
| **Design system** | | |
| Generate a design system — 60 components, tokens, screen grids, doc pages | — | ✅ |
| 10 visual styles, side-by-side preview, AI style recommendation | — | ✅ |
| Learn a system from the canvas or from design.md | — | ✅ |
| The tool asks the user the right questions, with time estimates | — | ✅ |
| **Quality and presentation** | | |
| Accessibility audit — contrast, touch targets, unnamed controls | — | ✅ |
| Responsive audit — stretch a screen, compare mobile and desktop | — | ✅ |
| Self-playing prototype demos | — | ✅ |
| Record a demo to video | — | ✅ |
| **Claude skills** | | |
| /figma-userflow, /figma-activity, /figma-sequence, /figma-erd, /figma-sitemap, /figma-state | ✅ | ✅ |
| /figma-usecase, /figma-journey, /figma-persona, /figma-design-system, /figma-demo | — | ✅ |
<!-- features:end -->

**[Get Pro →](https://ai4ba.com/figma-mcp)** — this table is generated from the feature list both editions ship from, so it is current with every release.

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
| Diagrams | Mermaid/plantuml text rendered to an image — each diagram an island | Every diagram frame **stores the model it was drawn from**: change one with `update` + `patch` instead of re-authoring it, and let the tools ask whether the diagrams on the page contradict each other |
| Business rules with a number | The `10 minutes` retyped into four diagrams; one gets updated, the others don't | `options.policies` holds the value once and labels reference it as `@hold-minutes` — a label cannot drift from a number it doesn't hold |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design rationale and the root-cause fixes behind these defaults.

## Quickstart

```bash
git clone https://github.com/hoangpm96/reqwise-figma-mcp.git
cd reqwise-figma-mcp
npm install
npm run build
```

This builds the server to `dist/` and the plugin bundle to `plugin/code.js`.

**Register the MCP server** — all editors at once (Cursor, Claude Code, Codex):

```bash
npm run install:mcp
```

or one editor by hand:

```bash
claude mcp add reqwise-figma -s user -- /absolute/path/to/reqwise-figma-mcp/scripts/reqwise-mcp.sh
```

**Import the plugin into Figma Desktop:** menu → **Plugins → Development → Import plugin from manifest…** → select `plugin/manifest.json`. Run it from **Plugins → Development → Reqwise Figma MCP** and keep its window open.

**Check the connection:** ask your agent to call `figma_status`. Full walkthrough and troubleshooting: [`docs/SETUP.md`](./docs/SETUP.md) and [`docs/INSTALL.md`](./docs/INSTALL.md). Several editors at once: [`docs/MULTI-AGENT.md`](./docs/MULTI-AGENT.md).

> **Every session:** open your Figma file → **Plugins → Development → Reqwise Figma MCP** → leave the window open. Figma doesn't auto-start plugins.

## Tools

| Tool | Purpose |
|---|---|
| `figma_status` | Rich connection diagnostics — plugin connection, leader/follower mode, heartbeat, queue, sessions, and an ordered `hints` list. Never a bare boolean. |
| `figma_read` | Read the canvas via an `op` enum (`get_document_info`, `get_selection`, `read_selection`, `get_design_context`, `get_design_system_kit`, `generate_design_md`, `search_nodes`, `screenshot`, `layout_audit`, `get_diagram_spec`, `get_page_model`, ...) with token-frugal responses. |
| `figma_write` | Execute modern-ES JavaScript against the `figma.*` proxy to create/modify the canvas. `state` persists per session. |
| `figma_rules` | One-call design-system rule sheet (styles + variables + components) as markdown — read before drawing so you reuse instead of hardcode. For a durable spec, use `figma_read` op `generate_design_md` and save the returned markdown as `design-kit.md`. |
| `figma_diagram` | Draw **six** diagram kinds from a model **you** derived from the spec, each with findings on the *content*, not the drawing. `type:"activity"` — a business process, with swimlanes or without: one band per owner, the handoffs between bands; reports an unlabelled handoff, a step nobody owns, a fork that never joins. `type:"sequence"` — an exchange over time: participants as columns, messages in the order you list them, activation bars derived from the calls and their replies, alt/loop blocks; reports a call nobody answers, a reply with no call, an alt with no else. `type:"state"` — the lifecycle of ONE entity: the values it can hold and every change that is allowed, written `event [guard] / action`; reports a state nothing can reach, a state nothing can leave, two transitions racing on one event. `type:"erd"` — a data model: tables, columns, keys, crow's-foot cardinality; reports what bites after a migration (no primary key, a foreign key to a column that does not exist, a many-to-many with no join table). `type:"userflow"` — the screens a user moves through, from a graph or a mermaid `flowchart`; reports a question with one way out, a dead end, an unreachable screen. `type:"sitemap"` — the pages a product is made of and what contains what, drawn as a tidy tree; reports an orphan page, a section with nothing under it, a depth nobody will navigate, and cross-checks against the userflows on the page. Write any of them in the compact `text` form at ~a third of the tokens, draw a whole set in one call (`diagrams: [...]`, placed for you), and **change** one with `update` + `patch` instead of re-authoring it. Every draw is cross-checked against the other diagrams on the page. Arrows stay attached on all of them: drag a box and every line touching it re-routes. |
| `figma_docs` | On-demand documentation: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes` \| `style` \| `userflow` \| `activity` \| `erd` \| `sequence` \| `sitemap` \| `state`. Read `style` when there's no design system to reuse — it's the brand-neutral default scale/palette/elevation to fall back on instead of inventing values. |

Full parameter reference for every operation and every `figma.*` method: [`docs/TOOLS.md`](./docs/TOOLS.md). Pro adds `figma_design_system` and `figma_record`, three more diagram kinds and the audits — see [Free vs Pro](#free-vs-pro).

## Diagram skills

[`.claude/skills/`](./.claude/skills/) ships a skill per diagram kind — `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-state`, `/figma-erd`, `/figma-sitemap` — plus the discipline they share (the connection gate, the four levels of "correct", the findings loop, verification). Copy them into `.claude/skills/` in your project. See [`.claude/skills/README.md`](./.claude/skills/README.md).

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

## Example: snapshot a design system to `design-kit.md`

Ask your agent to call:

```json
{ "op": "generate_design_md", "params": { "depth": 3, "includeAnatomy": true, "includeScreens": true } }
```

The response contains a source-grounded markdown snapshot: extraction coverage, colors,
typography, observed layout frequencies, screen composition evidence, local and
remote component usage, exact node ids/keys/variant ids/property keys, ready-to-run
instantiate examples, reuse rules, responsive evidence and known gaps. Save
it in the target codebase as **`design-kit.md`** before asking the agent to create UI
from an existing Figma component system. Facts are separated from observations and
unknown UX semantics. For a very large file, tune `maxComponents`, `maxScreens`,
`maxInstances` or `maxOutputChars`; output limits omit complete sections rather
than cutting Markdown mid-table/code-block.

> **`design.md` and `design-kit.md` are two different files** — human intent vs.
> machine snapshot, like `package.json` vs. `package-lock.json`. The tools never
> overwrite `design.md`. See the
> [two-file workflow](./docs/RECIPES.md#the-two-file-design-system-workflow).

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

- [`docs/SETUP.md`](./docs/SETUP.md) — **start here**: install, daily routine, troubleshooting
- [`docs/INSTALL.md`](./docs/INSTALL.md) — installation reference: env vars, port behaviour, leader/follower
- [`docs/TOOLS.md`](./docs/TOOLS.md) — full tool + `figma.*` API reference, error codes
- [`docs/MIGRATION.md`](./docs/MIGRATION.md) — migrating from `figma-ui-mcp`
- [`docs/RECIPES.md`](./docs/RECIPES.md) — practical cookbook
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design goals and internals

## Reqwise Figma MCP Pro

Pro is the full edition, built by the same author on this same core: a design-system generator with ten visual styles, use case diagrams, journey maps and persona sets, component authoring, accessibility and responsive audits, self-playing demos and demo videos. **[ai4ba.com/figma-mcp](https://ai4ba.com/figma-mcp)**

## License

MIT — see [`LICENSE`](./LICENSE). Reqwise Figma MCP Pro is a separate, commercially licensed product.
