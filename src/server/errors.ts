/**
 * Structured errors. Every error surfaced to the MCP client — and every
 * bridge error travelling between server and plugin — carries
 * {code, message, hint} (the "error messages teach the AI" philosophy).
 */
import { ErrorCode, type BridgeError } from "../shared/protocol.js";

export class OpError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "OpError";
    this.code = code;
    this.hint = hint;
  }

  toBridgeError(): BridgeError {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

/** Convert any thrown value into a BridgeError with a sensible default. */
export function toBridgeError(
  err: unknown,
  fallbackCode: ErrorCode = ErrorCode.INTERNAL,
  fallbackHint?: string,
): BridgeError {
  if (err instanceof OpError) {
    return err.toBridgeError();
  }
  if (err instanceof Error) {
    return {
      code: fallbackCode,
      message: err.message,
      ...(fallbackHint ? { hint: fallbackHint } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: String(err),
    ...(fallbackHint ? { hint: fallbackHint } : {}),
  };
}

export { ErrorCode };
export type { BridgeError };
