import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { installShutdown } from "../../src/server/shutdown.js";

/**
 * A client that disconnects closes our stdin but sends no signal. Only
 * SIGINT/SIGTERM used to trigger shutdown, so the bridge's HTTP server kept
 * the process alive as an orphan leader holding the port.
 */
function setup() {
  const stdin = new PassThrough();
  const signals = new EventEmitter();
  const close = vi.fn(async () => {});
  const exit = vi.fn();
  installShutdown({ close, stdin, signals: signals as unknown as NodeJS.Process, exit });
  return { stdin, signals, close, exit };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("installShutdown", () => {
  it("shuts down when the client closes stdin", async () => {
    const { stdin, close, exit } = setup();
    stdin.resume();
    stdin.end();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still shuts down on SIGTERM", async () => {
    const { signals, close, exit } = setup();
    signals.emit("SIGTERM");
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes once when a signal and stdin EOF both arrive", async () => {
    const { stdin, signals, close, exit } = setup();
    signals.emit("SIGTERM");
    stdin.resume();
    stdin.end();
    stdin.destroy();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits even when close() throws", async () => {
    const stdin = new PassThrough();
    const exit = vi.fn();
    const shutdown = installShutdown({
      close: async () => {
        throw new Error("boom");
      },
      stdin,
      signals: new EventEmitter() as unknown as NodeJS.Process,
      exit,
    });
    await expect(shutdown()).rejects.toThrow("boom");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
