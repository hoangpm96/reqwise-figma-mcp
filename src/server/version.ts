/**
 * Single source of the running version.
 *
 * At build time esbuild replaces `__VERSION__` with the package.json version
 * string (see scripts/build.mjs `define`). When running un-bundled (vitest,
 * tsx) the identifier does not exist, so we guard with `typeof` and fall back
 * to reading package.json. `declare const __VERSION__` lives in version.d.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolveVersion(): string {
  if (typeof __VERSION__ !== "undefined") {
    return __VERSION__;
  }
  try {
    // src/server/version.ts → ../../package.json
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = resolveVersion();
