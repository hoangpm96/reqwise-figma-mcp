# Migrating from `figma-ui-mcp`

Reqwise Figma MCP was designed from a failure analysis of `figma-ui-mcp` (and `figma-mcp-go`, and the wider MCP-for-Figma landscape). It keeps the parts that worked and fixes the parts that didn't — on purpose, the tool surface is a **superset**, so migration is mostly deletion of workarounds, not a rewrite.

## What's compatible

- **Same 5 tool names**: `figma_status`, `figma_read`, `figma_write`, `figma_rules`, `figma_docs`. Any orchestration code, skill, or prompt that calls these tools by name keeps working unmodified.
- **Same code-execution model**: `figma_write({ code })` still runs JavaScript against a `figma.*` proxy where every method is a `Promise`. Existing scripts that call `figma.create(...)`, `figma.modify(...)`, etc. continue to work as-is — you're not moving to a different execution paradigm, just gaining capabilities.
- **Read operations you already used** (`get_document_info`, `get_selection`, `get_node`, `screenshot`, `get_styles`, `get_variables`, `get_components`, ...) keep the same operation names and general parameter shapes.

## What changed

| Area | Before (`figma-ui-mcp`) | Now (Reqwise) |
|---|---|---|
| JavaScript syntax | Restricted/older ES — no `?.`, `??`, spread | Node `vm` sandbox — **full modern ES** (`?.`, `??`, spread, async/await, destructuring). Delete any workarounds you wrote to avoid these operators. |
| Session state | Token maps and id registries had to be re-declared at the top of every `figma_write` call | `state` (a plain object) **persists across calls in the same session** — set up tokens/constants once, reuse them in later calls. Stop copy-pasting the same setup block into every prompt. |
| Overlays/scrims | No dedicated helper — agents often built a semi-transparent `FRAME`, which dims its whole subtree | `figma.overlay({ color, opacity, parentId })` creates a correctly layered `RECTANGLE`. Delete manual overlay-frame code. |
| Text wrapping | Manual `layoutAlign`/`textAutoResize`/`lineHeight` juggling | `create({ type: "TEXT", wrap: true, ... })` sets all three correctly and warns if the parent has no fixed width. |
| Relative positioning | Manual `x`/`y` arithmetic from parent bounds | `inset: { left, right, top, bottom }` and `align: "center-x" \| "center-y" \| "center"` on `create` — the plugin computes the coordinates. |
| Z-order | Relied on creation order | `insertAt: "top" \| "bottom" \| { above: nodeId } \| { below: nodeId } \| index` on `create`/`move`. |
| Component reuse | Manual name search before creating | `findComponent` (fuzzy, path-aware, alias table) and `findOrCreateComponent(name, spec)` make reuse the default path. |
| Cloning | Cloned nodes required re-searching descendants by name | `clone(nodeId, { parentId, insertAt })` returns `{ id, childMap }` mapping original child ids → cloned child ids — index straight into the clone's descendants. |
| Multi-mode tokens | Only the current mode was set (a known bug — the other mode silently kept its default) | `setupTokens` sets values for **all modes** explicitly. |
| Batch size | Hard-capped (e.g. 50 ops), all-or-nothing | **No hard cap** — streams in chunks of 20 with progress pings, partial commit, and exact per-index error reporting. 200+ ops work the same way as 10. |
| Verification | Screenshot only | `layout_audit(nodeId)` returns declared vs. rendered bounds, `overflowsParent`, `clippedBy`, `textTruncated`, `zIndexWarnings` per node — verify with data, screenshot only for the final human check. |
| Connection diagnostics | Boolean-ish "connected"/"not connected" | `figma_status` returns a diagnostics object with `mode` (leader/follower), heartbeat age, queue length, sessions, and an ordered `hints` array naming the next concrete step. |
| Errors | Inconsistent shapes | Every error is `{ code, message, hint }`, drawn from a fixed `ErrorCode` enum. |
| Multi-window IDEs | Second server instance could fight for the port or fail silently | Leader/follower election with authenticated `/rpc` forwarding — both windows work identically from the caller's side. |

Nothing else needs to change — tool names, the `figma_write` execution model, and the general shape of `figma_read` operations are stable across the migration.
