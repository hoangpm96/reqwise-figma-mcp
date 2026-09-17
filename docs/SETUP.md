# Setup — Reqwise Figma MCP

> **What you get.** Once connected, you just *talk* to your AI — "draw me a login screen" — and it **draws it for real on your Figma canvas** while you watch.
>
> Everything runs **on your own machine**. No Figma login, no API token, nothing leaves your computer.

**Two ways to read this:**
- **You're a person** → start at §1. Setup is one prompt (§4); the rest is context and troubleshooting.
- **You're an AI told to set this up** → skip to **[§7 — Instructions for the AI](#7-instructions-for-the-ai)** and follow it.

---

## 1. How the pieces fit

Think of ordering food where the cook **speaks another language** and only accepts orders on their own form:

```
   YOU ask                                                    RESULT
      │                                                          ▲
      ▼                                                          │
 ┌──────────────┐      ┌─────────────────────┐      ┌──────────────────────┐
 │      AI      │ ───► │  Reqwise MCP server  │ ───► │  Plugin inside Figma  │
 │ Claude/Codex │      │     (the bridge)     │      │  (runs in the Figma   │
 │ /Antigravity │ ◄─── │   = the translator   │ ◄─── │   desktop app)        │
 └──────────────┘      └─────────────────────┘      └──────────────────────┘
   = the customer        turns words into the          = the cook
   "draw a login"        exact form the kitchen        actually draws it
                         accepts

        └──────────── all of it on YOUR machine ────────────┘
                   (nothing leaves your computer)
```

| Piece | Like | Job |
|---|---|---|
| **AI** (Claude Code / Codex / Antigravity / Cursor) | The customer | Says what you want in plain words: *"draw a login screen"* |
| **Reqwise MCP server** (the bridge) | The **translator** who knows the kitchen's rules | Turns intent into the exact structured order the kitchen accepts |
| **Plugin in Figma** | The cook | Receives a valid order → actually draws it on the canvas |

Because all three talk over your own machine:

- ✅ **No Figma login, no API token.**
- ✅ Everything stays local — fast, and nothing is uploaded.

When all three connect, the plugin panel turns 🟢 **"Connected"** — that's your green light.

### The bridge also *teaches* the AI how Figma works

Most people assume the bridge just passes messages along. It does something more important: it **teaches the AI the rules Figma draws by**, so the AI asks for the right thing.

The AI doesn't natively know what Figma expects. Figma can't parse *"draw a blue login box"* — it only understands **structured descriptions**: *"create a frame 360 wide, 480 tall, with a text field at x/y and a button with corner radius 8, fill #1E90FF…"*. Every element has its own name and required properties.

| What the bridge gives the AI | So the AI knows |
|---|---|
| **The rulebook** (`figma_rules`) | Which colors, fonts, spacing and components **already exist in your file** — so it reuses them instead of inventing lookalikes |
| **The syntax reference** (`figma_docs`) | Exactly which properties to declare to create a button, a frame, wrapping text… |
| **A structural verifier** (`layout_audit`) | Whether what it just drew actually overflows, clips or truncates — **as data**, not by squinting at a screenshot |

So when you say "draw a login screen", the AI **translates** that into a properly structured Figma order before sending it. That's why it comes out with the right layout, colors and sizes instead of something random.

```
  You say (plain words)      AI + bridge translate            Figma draws
  ───────────────────        (structured description)         ───────────
                                                             ┌─────────────┐
  "draw a login              {                               │    LOG IN   │
   screen,           ───►       "frame": { "w": 360,   ───►  │ ┌─────────┐ │
   dark theme"                            "h": 480 },        │ │ email   │ │
                                "button": { "radius": 8,     │ └─────────┘ │
                                   "fill": "#1E90FF" }       │ ┌─────────┐ │
                              }                              │ │ ••••••• │ │
                                                             │ └─────────┘ │
     ↑ humans understand        ↑ only Figma understands      │ [ Log in ]  │
                                                             └─────────────┘
```

> 🧠 **The analogy:** the bridge is a translator who knows the kitchen's rules. They don't just repeat the customer's words — they know which form the kitchen wants and which terms it uses, so the order comes back as the *right dish*. Without them, customer and cook talk past each other.

The third row above (`layout_audit`) is what separates this from "AI draws something roughly screen-shaped" — it checks its own work as data before showing you.

## 2. What you need

Just three things:

1. **Figma desktop app** — install the actual app. **The browser version will not work**; it can't run local plugins.
2. **Node.js 18 or newer** — you probably already have it if you've used other AI dev tools.
3. **One AI tool**: Claude Code, Codex, Antigravity, Cursor, …

> Not sure about Node? Open a terminal and run `node -v`. A version number like `v20.x` means you're fine. "command not found" means you need to install it first.
>
> Don't feel like typing commands? Just ask your AI: **"Check my node version"** — it'll run it and tell you. Missing? **"Install Node.js for me"**.

## 3. Unzip the package — somewhere permanent

Download the `.zip` and unzip it to a folder you won't move or delete — e.g. `~/Tools/reqwise-figma-mcp`. **Don't put it inside a project you're working on.**

Two separate folders matter here, and mixing them up is the most common setup mistake:

| Folder | What it is | You work in it? |
|---|---|---|
| **The MCP folder** (this zip) | Where the server lives. Install once, then forget it. | ❌ Never |
| **Your project folder** | Whatever you're actually building — the app, the docs, anything. | ✅ Yes, always |

The server is registered **once, globally**, so it's available in *every* project. You do not copy this package into each project, and you don't open your AI here to use it day-to-day — only for the one-time install below.

> The package contains source code, not a ready-to-run build — it gets compiled during install (one command, a few seconds). That's normal and keeps the download small.

## 4. Install it (once)

Open your AI **inside the unzipped folder**, just this once, and paste — filling in your editor's name:

```text
Read docs/SETUP.md, follow section 7, and set this up for me.
Register it globally so it works in all my projects.
I'm using: Claude Code
```

> - **Name your tool** (`Claude Code`, `Codex`, `Antigravity`, `Cursor`, `Claude Desktop`…). Each stores MCP servers in a **different** config file, and an AI can't reliably detect which app it's running inside — a wrong guess writes a config your editor never reads, and nothing appears.
> - **"Globally" matters.** Registered the default way, the server only works in the folder where you ran the command — so it would work in the MCP folder and nowhere else. See [§7.2](#72-register-the-server-globally).

The AI builds the project, registers the server, and verifies the connection. Then it hands you the two things it **cannot** do:

**A. Restart your AI tool** — config changes only take effect on restart.

**B. Install the plugin in Figma Desktop** (once):
1. **Plugins → Development → Import plugin from manifest…**
2. Pick `plugin/manifest.json` from the folder (the AI prints the full path)
3. Open any design file
4. **Plugins → Development → Reqwise Figma MCP**
5. **Leave that panel open** — minimizing is fine, closing disconnects

The panel shows 🟡 **"Connecting…"** until your AI is running, then 🟢 **"Connected"**.

Tell the AI **"done"** and it verifies. It should confirm it drew a test frame and removed it.

> Prefer doing it by hand? The exact commands per editor are in [§7.2](#72-register-the-server-globally).

## 5. Every session after that

**You never open the MCP folder again.** Work in your own project as usual — the server is registered globally, so the Figma tools are available everywhere.

This part repeats each session, because Figma doesn't auto-start plugins:

```
 ① Open Figma desktop → open your file
 ② Plugins → Development → Reqwise Figma MCP  (leave it open)
 ③ Open your AI in YOUR PROJECT folder → the light turns 🟢
 ④ ⭐ Check before drawing:  "Call figma_status — is the plugin connected?"
 ⑤ Ask it to draw:  "Draw me a login screen, dark theme."
```

> 📌 **Order to remember:** open the kitchen (plugin) → call the translator (AI) → wait for green → check the line is clear → order.

**Better results:** if your file already has a design system, say *"read the design system first, then draw"* — the AI reuses your real colors and components instead of inventing new ones.

### Cursor + Claude Code + Codex at the same time

You can run **several AI tools in parallel** on one Figma file. The first MCP process to start becomes **leader** (holds the plugin connection); the rest are **followers** and still expose the same tools.

1. After `npm run build`, run **`npm run install:mcp`** once — it writes `scripts/reqwise-mcp.sh` into Cursor, Codex, and Claude Code (user/global scope).
2. **Restart each editor** after install.
3. In any agent, call `figma_status` — `mode` is `"leader"` or `"follower"`; both are fine.
4. With **two Figma windows**, use `figma_read` op `list_channels` or pick a session in the plugin UI.

Full walkthrough: [`MULTI-AGENT.md`](./MULTI-AGENT.md).

### Drawing diagrams, not screens

The same server also draws userflows, activity diagrams, sequence diagrams, state machines and ERDs — from a model your AI derives from your spec, with findings about the *model* rather than the picture ("nobody can start this use case", "this record can never leave that state").

For that, the package ships nine skills in **`.claude/skills/`** — eight diagram kinds, plus

```
Read .claude/skills/README.md and install those skills for me, globally.
```


**Install them globally, not per project.** Skills are files, not part of the server: an MCP
connection alone gives the model the tools but nothing that says which one answers the
question in front of it. A project without them still draws — it just hand-rolls what a
skill would have routed in one call.

## 6. When something goes wrong

**Always try this first — paste it and let the AI fix itself:**

```text
The Figma connection isn't working. Please:
1. Call figma_status and report the state.
2. Check the "reqwise-figma" MCP server is registered in THIS tool, and that Node works.
3. Fix what you can yourself.
4. For anything you can't do (opening the plugin, restarting the app), walk me
   through it step by step.
```

| Symptom | Usual cause | Fix |
|---|---|---|
| **Works in the MCP folder, missing in your project** | registered per-project instead of globally | re-register with user/global scope — Claude Code: `claude mcp remove reqwise-figma -s local`, then re-add with `-s user` |
| AI has no Figma tools | didn't restart after installing | quit and reopen the AI tool |
| Plugin light not green | AI isn't running yet | open your AI, wait a few seconds |
| "No plugin connected" | plugin closed, or you're on Figma **web** | open the plugin in the **desktop** app |
| `Cannot find module …/dist/server/index.js` | build skipped, or wrong path | `npm run build`; re-register with **`scripts/reqwise-mcp.sh`** (full absolute path) |
| MCP **"not connected" / 0 tools** in Cursor (works in another editor) | mixed spawn (`node dist/…` vs launcher) or stale leader on `:38470` | `npm run install:mcp` · restart all editors · see [`MULTI-AGENT.md`](./MULTI-AGENT.md) |
| `mode: "follower"` but tools fail / election error on startup | follower cannot read leader token (`$TMPDIR` mismatch) | every editor must use **`reqwise-mcp.sh`**; kill stale server: `pkill -f reqwise-figma-mcp/dist/server` then restart MCP |
| Version mismatch | server rebuilt, plugin stale | rebuild **and re-import the manifest** |
| Changed settings, still nothing | didn't restart | always restart after config changes |

A light that flickers or goes yellow between actions is normal — it reconnects itself.

---

---

# 7. Instructions for the AI

**You are an AI asked to set this up.** Do §7.1–7.2 yourself, hand §7.3 to the user, verify in §7.4. **Setup is done only when `figma_status` returns `pluginConnected: true`.**

Rules: run commands without asking permission each time · skip what's already done · **merge** MCP configs, never rewrite · don't claim success unverified · adapt shell syntax to their OS.

**Which editor?** Take it from the user's prompt. **Don't infer it** — the same model runs in all of them, and a `claude` binary on the machine proves nothing. Not stated? Ask this, then stop:

> Which editor are you running me in (Claude Code, Cursor, Antigravity, Codex…)? Each stores MCP servers in a different config file.

## 7.1 Build

```bash
node -v                                   # need >=18, else stop: user must upgrade
ls dist/server/index.js plugin/code.js    # both exist → skip the build
npm install && npm run build              # only if a check failed
```

The distributed package ships **source only** — it contains neither `dist/` nor `plugin/code.js`, by design. Skipping this build is the #1 failure: §7.2 then registers a path that doesn't exist, and the Figma plugin loads with no code.

## 7.2 Register the server globally

**Register it globally (user scope), not per-project.** The user is installing from the unzipped MCP folder but will *use* it from their own project folders. A project-scoped registration would only work inside the MCP folder itself — i.e. nowhere useful — and the failure is silent: the tools just don't exist over there.

Path is always `<unzipped folder>/scripts/reqwise-mcp.sh`, absolute. Since you're running inside that folder, `$(pwd)` resolves it. (`scripts/cursor-agent-mcp.sh` is a deprecated alias.)

**Claude Code** — `-s user` is what makes it global (default is `local` = this folder only):

```bash
claude mcp add reqwise-figma -s user -- "$(pwd)/scripts/reqwise-mcp.sh"
claude mcp get reqwise-figma      # Scope should read "User config", not "Local config"
```

Already registered at the wrong scope? Remove and re-add:

```bash
claude mcp remove reqwise-figma -s local
```

**Codex** — `~/.codex/config.toml` is already global:

```bash
codex mcp add reqwise-figma -- "$(pwd)/scripts/reqwise-mcp.sh"
```

Or edit `~/.codex/config.toml`, alongside the existing `[mcp_servers...]` blocks:

```toml
[mcp_servers.reqwise-figma]
command = "<FULL PATH>/scripts/reqwise-mcp.sh"
args = []
```

**Everything else** — JSON, all sharing the `mcpServers` schema. **Use the global file, not the per-project one:**

| Editor | Global config (use this) |
|---|---|
| Antigravity | `~/.gemini/antigravity/mcp_config.json` — under `.gemini`, **not** `.antigravity` |
| Cursor | `~/.cursor/mcp.json` — **not** `<project>/.cursor/mcp.json`, which only covers one project |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` · Win: `%APPDATA%\Claude\` |

Confirm the path before writing — these move between versions:

```bash
find "$HOME" -maxdepth 5 -iname '*mcp*.json' 2>/dev/null | grep -iE 'antigravity|gemini|cursor|claude'
```

Nothing found → **don't invent a path.** Ask the user to add any server once via the editor's MCP settings (which creates the file), then merge into it.

**Merge one key — these files hold the user's other servers:**

```bash
CONFIG="$HOME/.cursor/mcp.json"          # ← the real path
[ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak"
node -e '
const fs=require("fs"),[c,s]=process.argv.slice(1);
const j=fs.existsSync(c)?JSON.parse(fs.readFileSync(c,"utf8")):{};
(j.mcpServers=j.mcpServers||{})["reqwise-figma"]={type:"stdio",command:s,args:[]};
fs.writeFileSync(c,JSON.stringify(j,null,2)+"\n");
console.log("servers now:",Object.keys(j.mcpServers).join(", "));
' "$CONFIG" "$(pwd)/scripts/reqwise-mcp.sh"
```

The printed list must still contain every server that was there before. Invalid JSON throws without writing — report it, don't hand-repair.

## 7.3 Hand over, then wait

```bash
echo "MANIFEST: $(pwd)/plugin/manifest.json"
```

Send them **A** and **B** from [§4](#4-install-it-once) with the real manifest path filled in, then **stop and wait for their reply.** Don't spin tools hoping something changes.

## 7.4 Verify

On "done", call `figma_status`. Read `hints` (ordered, most actionable first) and act — don't retry blindly.

| Result | Action |
|---|---|
| no such tool | user didn't restart (**A**) — most common miss |
| `pluginConnected: false` | user confirms **B.3–B.5** |
| `pluginConnected: null` | **unknown, not disconnected** → call again. Never say "reinstall the plugin" |
| `pluginConnected: true` | continue |

Space calls a few seconds — the plugin reconnects with 0.5→8s backoff and both sides heartbeat every 5s. Two or three spaced calls, not a tight loop.

Then prove a write works and clean up after yourself:

```js
const f = await figma.create({ type:"FRAME", name:"Setup check", width:200, height:100 });
await figma.delete(f.id);
```

**Now** report done, and tell them §5 repeats every session.

Other failures: [§6](#6-when-something-goes-wrong). `mode: "follower"` = second IDE window, normal. Port 38470 busy → the server walks 38471–38479 by itself; `figma_status.port` shows the real one. Error codes: [`TOOLS.md`](./TOOLS.md#error-codes).

## 7.5 Then: how to use it

1. `figma_docs({section:"api"})` — **read before your first write.** This is *not* the official Figma Plugin API. Sections: `rules`·`layout`·`api`·`tokens`·`icons`·`recipes`·`style`
2. `figma_rules()` — existing styles/variables/components, so you reuse instead of hardcoding
3. **Visual truth:** file has a design system → reuse it (`generate_design_md` → save as **`design-kit.md`**). Has none → `figma_docs({section:"style"})`. Never invent values ad hoc.
4. **Draw:** `create()` takes ONE spec object with `parentId` *inside* it · FRAME/COMPONENT without an explicit fill is **transparent** · `state` persists across calls
5. **Verify with data:** `figma_read({op:"layout_audit"})` for overflow/clipping/truncation. Screenshots are for the human's final look, not bug-hunting.
6. **Multi-screen flow?** Ask first: which screens, what states, platform, light/dark.

> `design.md` (human intent, never overwritten) ≠ `design-kit.md` (machine snapshot, regenerate freely) — [two-file workflow](./RECIPES.md#the-two-file-design-system-workflow).

---

**More:** [`RECIPES.md`](./RECIPES.md) — patterns · [`TOOLS.md`](./TOOLS.md) — full API reference
