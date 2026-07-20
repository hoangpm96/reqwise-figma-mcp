/**
 * Ambient globals injected at build time by esbuild (define).
 * In tsc / vitest these do not exist at runtime; consumers guard with
 * `typeof __VERSION__ !== "undefined"` and fall back (see version.ts).
 */
declare const __VERSION__: string;
