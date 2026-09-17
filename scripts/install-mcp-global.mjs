#!/usr/bin/env node
/**
 * Register reqwise-figma MCP in Cursor, Codex, and Claude Code (user/global scope)
 * from ONE source of truth: scripts/reqwise-mcp.sh in this repo.
 *
 *   npm run build
 *   node scripts/install-mcp-global.mjs
 *
 * Re-run after moving the repo or changing the launcher. Restart each editor afterward.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "scripts", "reqwise-mcp.sh");
const SERVER = join(ROOT, "dist", "server", "index.js");
const SERVER_NAME = "reqwise-figma";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`install-mcp-global: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(SERVER)) {
  fail(`missing ${SERVER} — run npm run build first`);
}
if (!existsSync(LAUNCHER)) {
  fail(`missing ${LAUNCHER}`);
}

const cursorPath = join(homedir(), ".cursor", "mcp.json");
const codexPath = join(homedir(), ".codex", "config.toml");

function mergeCursor() {
  mkdirSync(dirname(cursorPath), { recursive: true });
  let cfg = { mcpServers: {} };
  if (existsSync(cursorPath)) {
    try {
      cfg = JSON.parse(readFileSync(cursorPath, "utf8"));
    } catch {
      fail(`${cursorPath} is not valid JSON — fix manually, then re-run`);
    }
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  // Cursor sometimes fails to execute scripts on external volumes directly — bash + path is safer.
  cfg.mcpServers[SERVER_NAME] = {
    type: "stdio",
    command: "/bin/bash",
    args: [LAUNCHER],
  };
  if (existsSync(cursorPath)) {
    copyFileSync(cursorPath, `${cursorPath}.bak`);
  }
  writeFileSync(cursorPath, `${JSON.stringify(cfg, null, 2)}\n`);
  log(`✓ Cursor  ${cursorPath}`);
}

function mergeCodex() {
  const block = `[mcp_servers.${SERVER_NAME}]\ncommand = "${LAUNCHER}"\nargs = []\n`;
  let content = "";
  if (existsSync(codexPath)) {
    content = readFileSync(codexPath, "utf8");
    copyFileSync(codexPath, `${codexPath}.bak`);
  }
  const re = new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`);
  if (re.test(content)) {
    content = content.replace(re, block.trimEnd());
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += `\n${block}`;
  }
  mkdirSync(dirname(codexPath), { recursive: true });
  writeFileSync(codexPath, content);
  log(`✓ Codex   ${codexPath}`);
}

function mergeClaude() {
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (claude.status !== 0) {
    log(`– Claude  skipped (claude CLI not found)`);
    return;
  }
  spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "ignore" });
  const add = spawnSync("claude", ["mcp", "add", SERVER_NAME, "-s", "user", "--", LAUNCHER], {
    encoding: "utf8",
  });
  if (add.status !== 0) {
    log(`! Claude  claude mcp add failed:\n${add.stderr || add.stdout}`);
    log(`  Run manually: claude mcp add ${SERVER_NAME} -s user -- ${LAUNCHER}`);
    return;
  }
  log(`✓ Claude  user scope → ${LAUNCHER}`);
}

log(`Reqwise MCP launcher: ${LAUNCHER}\n`);
mergeCursor();
mergeCodex();
mergeClaude();
log(`
Done. Restart Cursor, Codex, and Claude Code so they reload MCP config.
First editor to connect becomes leader; the rest are followers (see docs/MULTI-AGENT.md).
`);
