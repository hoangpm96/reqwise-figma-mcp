/**
 * Shared filesystem locations under $TMPDIR/reqwise-figma-mcp/.
 * Used by leader discovery (leader-<port>.json + legacy leader.json) and the
 * icon SVG cache.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_FILE } from "../shared/protocol.js";

export function baseDir(): string {
  return join(tmpdir(), "reqwise-figma-mcp");
}

/**
 * Legacy single global discovery file. Multiple legitimate leaders (different
 * ports) contended for this one path — the root cause of the clobber/orphan
 * bug family. Still written best-effort so old-version followers can discover
 * a new-version leader during a mixed-version rollout.
 */
export function leaderFilePath(): string {
  return join(baseDir(), LEADER_FILE);
}

/**
 * Authoritative per-port discovery file. A leader owns its port exclusively,
 * so it owns this file exclusively too — two live leaders can never contend.
 */
export function leaderFilePathFor(port: number): string {
  return join(baseDir(), `leader-${port}.json`);
}

export function cacheDir(): string {
  return join(baseDir(), "cache");
}
