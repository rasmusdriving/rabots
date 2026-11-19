// Codex has two kinds of credits: a usage balance and credits that reset rate limits.
import type { UsageAccount } from "../../shared/protocol.js";

export const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function epochSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || value <= 0) return undefined;
  const d = new Date(value * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return epochSeconds(value);
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** The app-server uses camel case; WHAM's usage body uses snake case. Only copy known fields. */
export function codexCredits(value: unknown): UsageAccount["credits"] {
  const raw = record(value);
  if (!raw) return undefined;
  const has = raw.hasCredits ?? raw.has_credits;
  const balance = typeof raw.balance === "string" && /^\d+(?:\.\d+)?$/.test(raw.balance.trim())
    ? Number(raw.balance) : raw.balance;
  const expiresAt = isoTime(raw.expiresAt ?? raw.expires_at);
  const resetsAt = isoTime(raw.resetsAt ?? raw.resets_at);
  const credits = {
    ...(typeof has === "boolean" ? { hasCredits: has } : {}),
    ...(typeof raw.unlimited === "boolean" ? { unlimited: raw.unlimited } : {}),
    ...(typeof balance === "number" && Number.isFinite(balance) && balance >= 0 ? { balance } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
  return Object.keys(credits).length ? credits : undefined;
}

/** The local app-server reports a count independently of its optional list. */
export function codexResetCredits(value: unknown, now = Date.now()): UsageAccount["resetCredits"] {
  const raw = record(value);
  const availableCount = raw?.availableCount;
  if (typeof availableCount !== "number" || !Number.isSafeInteger(availableCount) || availableCount < 0) return undefined;
  const nextExpiresAt = availableCount > 0 && Array.isArray(raw?.credits)
    ? earliest(raw.credits.flatMap((value) => {
      const credit = record(value);
      const expiry = epochSeconds(credit?.expiresAt);
      return credit?.status === "available" && expiry && Date.parse(expiry) > now ? [expiry] : [];
    }))
    : undefined;
  return { availableCount, ...(nextExpiresAt ? { nextExpiresAt } : {}) };
}

/** The hub's read-only reset-credit endpoint lists credits; count only usable Codex ones, as T3 does. */
export function hubResetCredits(value: unknown, now = Date.now()): UsageAccount["resetCredits"] {
  const raw = record(value);
  if (!Array.isArray(raw?.credits)) return undefined;
  const available: string[] = [];
  for (const value of raw.credits) {
    const credit = record(value);
    if (typeof credit?.status !== "string" || typeof credit.reset_type !== "string") return undefined;
    if (credit.status !== "available" || credit.reset_type !== "codex_rate_limits") continue;
    const expiry = typeof credit.expires_at === "string" ? isoTime(credit.expires_at) : undefined;
    if (!expiry) return undefined;
    if (Date.parse(expiry) > now) available.push(expiry);
  }
  const nextExpiresAt = earliest(available);
  return { availableCount: available.length, ...(nextExpiresAt ? { nextExpiresAt } : {}) };
}

function earliest(times: string[]): string | undefined {
  return times.reduce<string | undefined>((first, time) => !first || time < first ? time : first, undefined);
}
