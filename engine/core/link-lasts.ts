// How long a connection lasts. Each side ends its own copy; the shorter choice wins.
// Followed T3 Code's apps/server/src/peer/PeerLinks.ts: an end time on the link, checked on every use.
import type { ConnectionLasts } from "../../shared/protocol.js";
import type { LinkRow } from "./link-store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An ended connection stays in the list this long, then goes by itself. */
export const ENDED_KEEP_MS = 7 * DAY;

export const LASTS: readonly ConnectionLasts[] = ["24h", "30d", "never"];
export const isLasts = (v: unknown): v is ConnectionLasts => LASTS.includes(v as ConnectionLasts);

export function lastsMs(lasts: ConnectionLasts | undefined): number | undefined {
  return lasts === "24h" ? DAY : lasts === "30d" ? 30 * DAY : undefined;
}

/** "24 hours", "30 days" or "never". */
export function lastsWords(lasts: ConnectionLasts | undefined): string {
  return lasts === "24h" ? "24 hours" : lasts === "30d" ? "30 days" : "never";
}

/** The quiet line for a change: "ends after 30 days (was never)". */
export function lastsChange(next: ConnectionLasts, before: ConnectionLasts | undefined): string {
  const now = next === "never" ? "lasts until removed" : `ends after ${lastsWords(next)}`;
  return `${now} (was ${lastsWords(before)})`;
}

/** When this side's copy ends, once both sides are connected. */
export function endsAt(row: LinkRow): number | undefined {
  const ms = lastsMs(row.lasts);
  const from = row.lastsFrom ?? row.confirmed;
  return ms === undefined || from === undefined ? undefined : from + ms;
}

/** True when the time is up and the copy has not ended yet. */
export function due(row: LinkRow, now: number): boolean {
  const end = endsAt(row);
  return !row.ended && end !== undefined && end <= now;
}
