/**
 * Build script:
 *  - server:  src/server/index.ts  → dist/server/index.js (Node ESM bundle)
 *  - plugin:  src/plugin/main.ts   → plugin/code.js (IIFE, target es2017 for the Figma sandbox)
 * The package.json version is injected into both bundles as __VERSION__.
 */
import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  define: { __VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
  minify: true,
  sourcemap: true,
};

const serverConfig = {
  ...common,
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.js",
  platform: "node",
  format: "esm",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  // Keep runtime deps external so npm installs them; bundle only our code.
  packages: "external",
};

const pluginConfig = {
  ...common,
  entryPoints: ["src/plugin/main.ts"],
  outfile: "plugin/code.js",
  platform: "browser",
  format: "iife",
  target: "es2017",
};

if (watch) {
  const [s, p] = await Promise.all([context(serverConfig), context(pluginConfig)]);
  await Promise.all([s.watch(), p.watch()]);
  console.log("watching…");
} else {
  await Promise.all([build(serverConfig), build(pluginConfig)]);
}
