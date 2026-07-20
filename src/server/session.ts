/**
 * Session registry.
 *
 * A "session" is the persistence scope for figma_write code execution: the
 * `state` object exposed as a global in the vm sandbox survives across
 * figma_write calls with the same sessionId (token maps, node-id registries,
 * constants). Callers that omit sessionId share the DEFAULT_SESSION.
 */

export const DEFAULT_SESSION = "default";

export interface Session {
  id: string;
  /** Persistent, mutable state object exposed as global `state` in the vm. */
  state: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number;
  writeCount: number;
  /** One-shot flag: the "no tokens — propose a palette" nudge already fired. */
  paletteNudged?: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  /** Get (creating on first use) the session for the given id. */
  get(sessionId?: string): Session {
    const id = sessionId && sessionId.length > 0 ? sessionId : DEFAULT_SESSION;
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        state: {},
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        writeCount: 0,
      };
      this.sessions.set(id, session);
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  reset(sessionId?: string): void {
    const id = sessionId && sessionId.length > 0 ? sessionId : DEFAULT_SESSION;
    this.sessions.delete(id);
  }

  /** Lightweight summaries for figma_status diagnostics. */
  summaries(): Array<{
    id: string;
    writeCount: number;
    stateKeys: number;
    lastUsedMs: number;
  }> {
    const now = Date.now();
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      writeCount: s.writeCount,
      stateKeys: Object.keys(s.state).length,
      lastUsedMs: now - s.lastUsedAt,
    }));
  }
}
