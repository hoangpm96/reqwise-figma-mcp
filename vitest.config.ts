import { defineConfig } from "vitest/config";

/**
 * Scope the suite to the product tree. Local research materials under
 * `untrack/` (AI kits, brainstorm package) may contain template `*.spec.ts`
 * or kit `*.test.mjs` files that must not be collected as project tests.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.{ts,js,mjs}"],
    exclude: ["node_modules", "dist", "untrack/**", "plugin/**"],
  },
});
