/**
 * Build the distributable ZIP users download.
 *
 * Ships SOURCE, not build output: the user runs `npm install && npm run build`
 * themselves (see docs/SETUP.md §3). So we deliberately exclude dist/,
 * plugin/code.js and node_modules — including a stale build output would be
 * worse than shipping none, since the user's build silently overwrites it and
 * any mismatch surfaces as a confusing version error.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `${pkg.name}-${pkg.version}`;

// Everything a user needs to build and run from scratch.
const INCLUDE = [
  "src",
  "tests",
  "scripts",
  "docs",
  ".claude/skills",
  "plugin/manifest.json",
  "plugin/ui.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.plugin.json",
  "assets",
  "README.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "LICENSE",
];

const stage = mkdtempSync(join(tmpdir(), "reqwise-pkg-"));
const dest = join(stage, name);
mkdirSync(dest, { recursive: true });

let missing = 0;
for (const rel of INCLUDE) {
  const from = join(root, rel);
  if (!existsSync(from)) {
    console.error(`  missing: ${rel}`);
    missing++;
    continue;
  }
  cpSync(from, join(dest, rel), { recursive: true });
}
if (missing) {
  rmSync(stage, { recursive: true, force: true });
  console.error(`\n${missing} required path(s) missing — aborting.`);
  process.exit(1);
}

const out = join(root, `${name}.zip`);
rmSync(out, { force: true });
// -r recurse, -q quiet, -X drop macOS resource forks.
execFileSync("zip", ["-rqX", out, name], { cwd: stage, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

const bytes = readFileSync(out).length;
console.log(`\n  ${name}.zip  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  → users unzip, then: npm install && npm run build\n`);
