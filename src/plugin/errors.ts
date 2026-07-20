// NOTE: no @figma/plugin-typings reference — this module is figma-global-free
// on purpose so pure plugin logic (and its tests) can import it without
// dragging Figma's DOM-flavored globals into the server typecheck program.
import { ErrorCode, BridgeError } from "../shared/protocol.js";

/** A handler-thrown error carrying a structured BridgeError payload. */
export class HandlerError extends Error {
  code: ErrorCode;
  hint?: string;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
    this.hint = hint;
  }
}

export function err(code: ErrorCode, message: string, hint?: string): HandlerError {
  return new HandlerError(code, message, hint);
}

export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof HandlerError) {
    return { code: e.code, message: e.message, hint: e.hint };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: ErrorCode.INTERNAL, message };
}

/** Raise NODE_NOT_FOUND with a helpful hint. */
export function nodeNotFound(id: string): HandlerError {
  return err(
    ErrorCode.NODE_NOT_FOUND,
    `No node with id "${id}".`,
    "Call get_selection or search_nodes to obtain a current node id; ids change between sessions.",
  );
}
