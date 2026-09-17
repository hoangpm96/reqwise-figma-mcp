/**
 * Process lifetime for the stdio binary.
 *
 * The MCP client owns this process through its stdin pipe. When the client
 * goes away (window closed, session reloaded, client crashed) the pipe hits
 * EOF — but no signal is delivered, and StdioServerTransport does not watch
 * for EOF. The bridge's HTTP server then keeps the event loop alive forever:
 * an orphan (PPID=1) that still holds the bridge port, so the next session
 * becomes a follower of a leader nobody drives. scripts/reqwise-mcp.sh kills
 * such orphans on launch, but `npx reqwise-figma-mcp` and any other direct
 * launch had no such guard.
 *
 * So stdin EOF is treated exactly like SIGTERM. Followers of this leader
 * notice via their health monitor and take over the port.
 */
import type { Readable } from "node:stream";

export interface ShutdownDeps {
  close: () => Promise<void>;
  stdin?: Readable;
  signals?: Pick<NodeJS.Process, "on">;
  exit?: (code: number) => void;
}

/** Wire signals + stdin EOF to one idempotent shutdown; returns it. */
export function installShutdown(deps: ShutdownDeps): () => Promise<void> {
  const stdin = deps.stdin ?? process.stdin;
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let running: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    // SIGTERM followed by the pipe closing (or 'end' then 'close') must not
    // run close() twice — a second bridge.close() races the first.
    running ??= (async () => {
      try {
        await deps.close();
      } finally {
        exit(0);
      }
    })();
    return running;
  };

  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
  stdin.on("end", shutdown);
  stdin.on("close", shutdown);
  return shutdown;
}
