/**
 * Shared filesystem locations under $TMPDIR/reqwise-figma-mcp/.
 * Used by leader discovery (leader.json) and the icon SVG cache.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_FILE } from "../shared/protocol.js";

export function baseDir(): string {
  return join(tmpdir(), "reqwise-figma-mcp");
}

export function leaderFilePath(): string {
  return join(baseDir(), LEADER_FILE);
}

export function cacheDir(): string {
  return join(baseDir(), "cache");
}
