// Only usage metadata survives a line, never message content, tool data or a working directory.
import { createHash } from "node:crypto";
import type { UsageSpeed } from "../../../shared/protocol.js";
import type { UsageRecord } from "./types.js";

export type Fields = Record<string, unknown>;
export function fields(v: unknown): Fields {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Fields : {};
}
export const count = (v: unknown): number => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
export const stamp = (v: unknown): number => typeof v === "string" ? Date.parse(v) : NaN;
export const modelName = (v: unknown): string => typeof v === "string" && /^(?:(?:openai|anthropic)\/)?[a-z\d][a-z\d._:-]{0,95}(?:\[\d+m\])?$/i.test(v)
  ? v : "Unknown model";
export const fingerprint = (...parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 24);
export function speedOf(v: unknown): UsageSpeed {
  return v === "priority" || v === "fast" ? "fast" : v === "ultrafast" ? "ultrafast" : "standard";
}

export function claudeRecords(record: Fields, file: string): UsageRecord[] {
  if (record.type !== "assistant") return [];
  const at = stamp(record.timestamp);
  const message = fields(record.message);
  const usage = fields(message.usage);
  if (!Number.isFinite(at) || !message.usage || message.model === "<synthetic>") return [];
  const session = typeof record.sessionId === "string" ? fingerprint(record.sessionId) : file;
  const messageId = typeof message.id === "string" ? message.id : "";
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const key = messageId || requestId ? fingerprint(messageId || requestId, requestId) : "";
  const speed = speedOf(usage.speed);
  const tokens = (u: Fields) => ({
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    cacheWriteHour: Math.min(count(u.cache_creation_input_tokens), count(fields(u.cache_creation).ephemeral_1h_input_tokens)),
    output: count(u.output_tokens),
  });
  const reported = typeof record.costUSD === "number" && record.costUSD >= 0 && record.costUSD < 1e9 ? record.costUSD : undefined;
  const result: UsageRecord[] = [{ at, model: modelName(message.model), session, key, speed, ...tokens(usage), ...(reported !== undefined ? { reported } : {}) }];
  if (Array.isArray(usage.iterations)) for (const [i, value] of usage.iterations.entries()) {
    const advisor = fields(value);
    if (advisor.type !== "advisor_message" || advisor.model === "<synthetic>") continue;
    result.push({ at, model: modelName(advisor.model), session, key: key ? fingerprint(key, i) : "", speed, ...tokens(advisor) });
  }
  return result.filter((r) => r.input + r.cacheRead + r.cacheWrite + r.output > 0 || (r.reported ?? 0) > 0);
}
