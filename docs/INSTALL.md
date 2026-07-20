# Installation & Setup

## Prerequisites

- **Node.js ≥ 18** (the server uses native `fetch`, `vm`, and ES modules; `package.json` sets `"engines": { "node": ">=18" }`).
- **Figma Desktop** — the plugin uses `networkAccess.allowedDomains` restricted to `localhost`, which only Figma Desktop (not the web app in most setups) reliably permits for local plugin development. Use the desktop app.
- An MCP-capable client: Claude Code, Cursor, Claude Desktop, or any client that speaks stdio MCP.

## Build from source

```bash
git clone https://github.com/<you>/reqwise-figma-mcp.git
cd reqwise-figma-mcp
npm install
npm run build
```

`npm run build` runs `scripts/build.mjs` (esbuild), which produces two artifacts:

- `dist/server/**` — the MCP server, run with `node dist/server/index.js`.
- `plugin/code.js` — the Figma plugin's main-thread bundle (target `es2017`, IIFE), built alongside the existing `plugin/manifest.json` and `plugin/ui.html`.

Useful scripts:

| Script | Purpose |
|---|---|
| `npm run build` | One-off build (server + plugin) |
| `npm run build:watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the vitest suite (executor sandbox, validator, bridge, leader/follower, safe-defaults) |
| `npm start` | Run the built server directly (`node dist/server/index.js`) |

The server is also exposed as a bin: `reqwise-figma-mcp` → `dist/server/index.js` (see `package.json`). If you `npm link` or install globally, you can invoke it by name instead of a full path.

## Registering the MCP server

The server speaks MCP over **stdio**. Point your client at the built entry file.

### Claude Code

```bash
claude mcp add reqwise-figma -- node /absolute/path/to/reqwise-figma-mcp/dist/server/index.js
```

Verify it registered:

```bash
claude mcp list
```

### Cursor

Add to `.cursor/mcp.json` (project) or the global Cursor MCP config:

```json
{
  "mcpServers": {
    "reqwise-figma": {
      "command": "node",
      "args": ["/absolute/path/to/reqwise-figma-mcp/dist/server/index.js"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "reqwise-figma": {
      "command": "node",
      "args": ["/absolute/path/to/reqwise-figma-mcp/dist/server/index.js"]
    }
  }
}
```

Restart the client after editing its config so it picks up the new server.

### Running via npx (once published)

If the package is published to npm:

```json
{
  "mcpServers": {
    "reqwise-figma": {
      "command": "npx",
      "args": ["-y", "reqwise-figma-mcp"]
    }
  }
}
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `FIGMA_MCP_PORT` | `38470` | Start port for the bridge. The server still walks up to 9 ports from here when the chosen one is busy, and still becomes a follower if a healthy leader already owns one. |

`FIGMA_MCP_PORT` must be an integer in `1024`–`65535`; anything else (a typo, a privileged port) aborts startup with an explicit error rather than silently reverting to the default.

**Keep it inside `38470`–`38479`.** The Figma plugin scans only that window, and `plugin/manifest.json` allowlists only those hosts in its CSP, so a server bound outside the range is unreachable from the plugin no matter what. The server warns on stderr if you do it anyway:

```json
{
  "mcpServers": {
    "reqwise-figma": {
      "command": "npx",
      "args": ["-y", "reqwise-figma-mcp"],
      "env": { "FIGMA_MCP_PORT": "38475" }
    }
  }
}
```

## Importing the plugin into Figma Desktop

1. Open Figma Desktop.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `plugin/manifest.json` from this repo (built alongside `plugin/code.js` and `plugin/ui.html`).
4. Open any file, then **Plugins → Development → Reqwise Figma MCP** to launch it.
5. **Keep the plugin window open.** The plugin's `ui.html` holds the WebSocket connection to the server; closing the plugin window drops the connection (the server will report `pluginConnected: false` and the heartbeat will go stale).

The plugin only ever talks to `localhost` — its `manifest.json` allowlists `http(s)://localhost:38470` through `38479` (the default port plus the 9-port fallback range) for both HTTP and WS. It does not phone home anywhere else, except the on-demand, cached icon fetches described in `docs/TOOLS.md` (icon SVGs come from a public CDN, not the Figma bridge).

## Connection walkthrough

Once the server is registered and the plugin is running, ask your agent to call `figma_status`. Read the `hints` array — it is an ordered list of the most actionable next step first. Typical progressions:

1. **Server just started, plugin not opened yet:**
   ```json
   { "pluginConnected": false, "hints": ["No Figma plugin connected. Open Figma Desktop → Plugins → Reqwise, and keep the plugin window open."] }
   ```
   → Open the plugin as described above.

2. **Plugin connected, everything fine:**
   ```json
   { "pluginConnected": true, "mode": "leader", "hints": ["All systems nominal. Draw with figma_write; verify with figma_read layout_audit."] }
   ```
   → Proceed.

3. **Second IDE window / second server process:**
   ```json
   { "mode": "follower", "hints": ["This process is a FOLLOWER; operations forward to the leader over /rpc. This is normal with multiple IDE windows."] }
   ```
   → Normal. Both processes work identically from the tool caller's perspective; only one owns the actual plugin WebSocket.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `figma_status` shows `bridgeAuth: "missing"` | `leader-<port>.json` (in `$TMPDIR/reqwise-figma-mcp/`) was not written or is unreadable | Restart the MCP server process. If the problem persists, check filesystem permissions on `$TMPDIR`. |
| Port conflict / server won't bind `38470` | Another process (or a previous crashed server) holds the port | The server automatically tries `38471`–`38479` and becomes a **follower** if a healthy leader already owns one of those ports; if none respond, restart or free the port manually. `figma_status.port` tells you which port is actually in use. To pin a specific start port, set `FIGMA_MCP_PORT` (see below). |
| Server binds a custom `FIGMA_MCP_PORT` but the plugin never connects | The port is outside `38470`–`38479` | The plugin scans only that window, and its `manifest.json` CSP allowlists only those hosts — a port outside it can never be reached. The server warns about this on stderr at startup. Use a port inside the range. |
| `pluginConnected: false` after opening the plugin | Plugin window was closed, or never finished its handshake | Reopen **Plugins → Development → Reqwise Figma MCP** and keep the window open (it can be minimized but not closed). |
| `hints` mentions "No heartbeat for Ns" | The Figma window is minimized/backgrounded, or the machine went to sleep, and the ping/pong cadence (10 s) lapsed past the 30 s dead threshold | Bring Figma to the foreground; the plugin reconnects with backoff (0.5 s → 8 s cap) automatically. |
| `hints` mentions a plugin/server version mismatch | You updated the server (new `PROTOCOL_VERSION`) but the Figma plugin still has the old bundle | Re-import the plugin: **Plugins → Development → Import plugin from manifest…** again, pointing at the freshly built `plugin/manifest.json`, or use **Plugins → Development → Reqwise Figma MCP → Update** if Figma offers it. |
| Multiple IDE windows, unsure which owns the plugin | Only the **leader** holds the actual plugin WebSocket; followers forward via `/rpc` | Check `figma_status.mode`. Both leader and follower expose the same 5 tools; you don't need to target the leader specifically. |
| `figma_write` throws `NOT_CONNECTED` | No plugin connected, or the bridge died mid-session | Call `figma_status` first; reopen the plugin if `pluginConnected` is `false`. |
| `pluginConnected: null` with `"statusSource": "unknown"` | This process is a **follower** and could not query the leader for status (leader busy, restarting, or dead) | Nothing to do with the plugin — do **not** reopen or reinstall it. Just retry; the follower's health monitor takes over leadership if the leader is truly dead. |

For the full error code table (what each `code` means and how to react), see [`TOOLS.md`](./TOOLS.md#error-codes).
