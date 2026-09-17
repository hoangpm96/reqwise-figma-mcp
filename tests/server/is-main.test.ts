import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDirectRun } from "../../src/server/is-main.js";

/**
 * The direct-run check used to compare `import.meta.url` (URL-encoded,
 * realpath-resolved) to `"file://" + argv[1]` (raw path, as invoked). Every
 * launch layout where those differ — spaces, URL-encodable chars, symlinks,
 * macOS /tmp → /private/tmp — silently exited with no tools. The npm `bin`
 * symlink made it affect every global install.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqwise ismain-")); // space on purpose
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isDirectRun", () => {
  it("is true for a plain direct invocation", async () => {
    const file = join(dir, "server.js");
    await writeFile(file, "");
    expect(isDirectRun(pathToFileURL(file).href, file)).toBe(true);
  });

  it("is true when the path contains spaces (meta URL is %20-encoded)", async () => {
    const file = join(dir, "my server.js");
    await writeFile(file, "");
    // argv[1] carries the raw path; import.meta.url carries the encoded one.
    expect(pathToFileURL(file).href).toContain("%20");
    expect(isDirectRun(pathToFileURL(file).href, file)).toBe(true);
  });

  it("is true when invoked through a symlink (npm bin / /tmp→/private/tmp)", async () => {
    const real = join(dir, "real.js");
    const link = join(dir, "linked.js");
    await writeFile(real, "");
    await symlink(real, link);
    // Loader reports the real path; argv[1] carries the symlink path.
    expect(isDirectRun(pathToFileURL(real).href, link)).toBe(true);
  });

  it("is false for a different file (the import case)", async () => {
    const file = join(dir, "server.js");
    const other = join(dir, "test.js");
    await writeFile(file, "");
    await writeFile(other, "");
    expect(isDirectRun(pathToFileURL(file).href, other)).toBe(false);
  });

  it("is false with no argv[1] and never throws on bad input", () => {
    expect(isDirectRun("file:///nonexistent.js", undefined)).toBe(false);
    expect(isDirectRun("not a url", join(dir, "ghost.js"))).toBe(false);
  });
});
