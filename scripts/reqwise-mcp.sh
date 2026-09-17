#!/usr/bin/env bash
# Stdio MCP launcher for Cursor, Claude Code, Codex, and other MCP clients.
#
# Each client spawns one process per session. Orphan leaders (PPID=1) keep port
# 38470 and break the next session: the new instance becomes a follower that
# never answers on stdio → "Connection closed".
#
# Some clients use a stripped PATH (/usr/bin:/bin/…). `node` from pnpm, nvm or
# Homebrew is then invisible, the script exits 127, and the client shows
# "Error loading MCP, unable to list tools."
#
# Discovery files live at $TMPDIR/reqwise-figma-mcp/leader-<port>.json (see
# paths.ts). Every client MUST share the same TMPDIR parent — not /tmp vs
# per-user temp, and never $HOME/.cache/reqwise-figma-mcp as TMPDIR itself
# (that double-nests reqwise-figma-mcp/ and breaks follower election).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/dist/server/index.js"

# pgrep -f matches argv: `node <abs path>/dist/server/index.js`. The old fixed
# "reqwise-figma-mcp/dist/…" pattern only matched a checkout that kept the
# repo's directory name. "$SERVER" is this checkout's own path, so a renamed
# checkout still finds its orphans; the reqwise* alternative still sees a
# differently-named sibling checkout holding the port.
SRV_RE="${SERVER}|reqwise[^ ]*/dist/server/index\.js"

# --- canonical TMPDIR (parent of reqwise-figma-mcp/) ---
if [ -n "${REQWISE_MCP_TMPDIR:-}" ]; then
  export TMPDIR="${REQWISE_MCP_TMPDIR%/}"
else
  darwin_tmp="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  if [ -n "$darwin_tmp" ]; then
    export TMPDIR="${darwin_tmp%/}"
  elif [ -n "${HOME:-}" ]; then
    export TMPDIR="${HOME}/.cache"
  else
    export TMPDIR="/tmp"
  fi
fi
mkdir -p "${TMPDIR}/reqwise-figma-mcp"

# Leader on :38470 but no discovery file → followers exit fatal ("0 tools").
if command -v curl >/dev/null 2>&1; then
  if curl -sf --max-time 1 "http://127.0.0.1:38470/health" >/dev/null 2>&1; then
    if [ ! -f "${TMPDIR}/reqwise-figma-mcp/leader-38470.json" ]; then
      # Kill only the process HOLDING the port — a pattern kill used to take
      # down healthy leaders serving other sessions (e.g. a second client
      # with a different TMPDIR that can see the port but not its file).
      if command -v lsof >/dev/null 2>&1; then
        for pid in $(lsof -nP -tiTCP:38470 -sTCP:LISTEN 2>/dev/null || true); do
          kill "$pid" 2>/dev/null || true
        done
      else
        for pid in $(pgrep -f "$SRV_RE" 2>/dev/null || true); do
          kill "$pid" 2>/dev/null || true
        done
      fi
      sleep 0.25
    fi
  fi
fi

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  local c nvm_dir nvm_node
  # pnpm and nvm install under $HOME, which a stripped environment may leave
  # unset — without the guard, `set -u` kills the script on the bare "$HOME"
  # before the absolute-path candidates below are even tried.
  if [ -n "${HOME:-}" ]; then
    for c in \
      "$HOME/Library/pnpm/node" \
      "$HOME/.local/share/pnpm/node"
    do
      if [ -x "$c" ]; then
        echo "$c"
        return
      fi
    done
  fi
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    if [ -x "$c" ]; then
      echo "$c"
      return
    fi
  done
  if [ -n "${HOME:-}" ]; then
    # Version dirs sort lexically (v9 lands after v20) — sort the numeric
    # fields or tail -1 hands back the wrong end of the list.
    nvm_dir="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null \
      | sort -t. -k1.2,1n -k2,2n -k3,3n \
      | tail -n 1 || true)"
    nvm_node="$HOME/.nvm/versions/node/$nvm_dir/bin/node"
    if [ -n "${nvm_dir:-}" ] && [ -x "$nvm_node" ]; then
      echo "$nvm_node"
      return
    fi
  fi
  echo "reqwise-mcp: node not found (PATH=${PATH:-})" >&2
  exit 127
}

NODE="$(resolve_node)"

for pid in $(pgrep -f "$SRV_RE" 2>/dev/null || true); do
  ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)"
  if [ "$ppid" = "1" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done

sleep 0.15
exec "$NODE" "$SERVER"
