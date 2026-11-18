// Errors that go back to the app as a response with `ok: false`.
import type { ErrorBody } from "../shared/protocol.js";

export type ErrorCode = "bad_request" | "not_found" | "conflict" | "protocol_mismatch" | "harness_unavailable" | "unavailable" | "too_large" | "unsupported" | "too_many" | "internal";

export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  return { code: "internal", message: "Something went wrong in the engine. The details are in its log." };
}
