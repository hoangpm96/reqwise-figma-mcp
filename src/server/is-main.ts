/**
 * "Was this module executed directly?" — the isMain check.
 *
 * The naive form, `import.meta.url === "file://" + process.argv[1]`, silently
 * returns false in three real launch layouts, and a false negative means the
 * process exits 0 with no tools and no error:
 *
 *  - Paths with spaces or other URL-encodable characters: import.meta.url
 *    contains `dir%20with%20space` while argv[1] holds the raw path.
 *  - Symlinks: argv[1] is the path AS INVOKED (an npm bin symlink, macOS
 *    /tmp → /private/tmp, an nvm/pnpm prefix); the ESM loader reports the
 *    realpath-resolved URL. With `bin` declared in package.json this made
 *    `npx reqwise-figma-mcp` / global installs never start at all.
 *  - Mixed forms like `node ./dist/server/index.js` are fine — Node makes
 *    argv[1] absolute — but realpath is still required for the cases above.
 *
 * So both sides are converted to filesystem paths and canonicalised with
 * realpathSync before comparing.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectRun(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    // A missing/unresolvable path must not crash module import.
    return false;
  }
}
