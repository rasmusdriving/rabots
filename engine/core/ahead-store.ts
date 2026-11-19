// Ahead's items (engine 0.39.0, docs/build/step-ahead.md). Reached as `store.ahead`.
//
// Made with IF NOT EXISTS beside the numbered migrations (as the to-dos and the calendar tables
// are), so the schema number stays and an older engine that opens the database never reads it.
// `data` is the whole AheadItem as JSON; the columns beside it are for the queries.
// `passed_told` is the day a bot was told its item's day had passed, so it is told once per day set.

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { AheadItem, AheadState } from "../../shared/protocol.js";

export function makeAheadTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ahead_items (
      id TEXT PRIMARY KEY,
      bot_id TEXT,
      state TEXT NOT NULL,
      day TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      passed_told TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ahead_items_open ON ahead_items (state, day);
    CREATE INDEX IF NOT EXISTS ahead_items_bot ON ahead_items (bot_id, state);
  `);
}

export function newAheadId(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return "ahd_" + [...randomBytes(16)].map((b) => abc[b % abc.length]).join("");
}

const parse = (r: { data: unknown }) => JSON.parse(String(r.data)) as AheadItem;

export class AheadStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Adds or replaces an item. */
  put(item: AheadItem): void {
    this.db
      .prepare(
        `INSERT INTO ahead_items (id, bot_id, state, day, changed_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bot_id = excluded.bot_id, state = excluded.state, day = excluded.day,
           changed_at = excluded.changed_at, data = excluded.data`,
      )
      .run(item.id, item.botId ?? null, item.state, item.day, item.changedAt, JSON.stringify(item));
  }

  get(id: string): AheadItem | undefined {
    const r = this.db.prepare("SELECT data FROM ahead_items WHERE id = ?").get(id) as { data: unknown } | undefined;
    return r ? parse(r) : undefined;
  }

  /** Open items of one bot (null: the person's own). */
  countOpen(botId: string | null): number {
    const r = (botId === null
      ? this.db.prepare("SELECT COUNT(*) AS n FROM ahead_items WHERE state = 'open' AND bot_id IS NULL").get()
      : this.db.prepare("SELECT COUNT(*) AS n FROM ahead_items WHERE state = 'open' AND bot_id = ?").get(botId)) as { n: number };
    return Number(r.n);
  }

  /**
   * Items by day, oldest day first. `botId` undefined: every bot's and the person's; null: the
   * person's own only. `from`/`to` are YYYY-MM-DD, both inclusive.
   */
  list(o: { botId?: string | null; states?: AheadState[]; from?: string; to?: string; limit?: number } = {}): AheadItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.botId === null) where.push("bot_id IS NULL");
    else if (o.botId !== undefined) { where.push("bot_id = ?"); args.push(o.botId); }
    const states = o.states ?? ["open"];
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    args.push(...states);
    if (o.from) { where.push("day >= ?"); args.push(o.from); }
    if (o.to) { where.push("day <= ?"); args.push(o.to); }
    args.push(o.limit ?? 2000);
    const rows = this.db
      .prepare(`SELECT data FROM ahead_items WHERE ${where.join(" AND ")} ORDER BY day, changed_at LIMIT ?`)
      .all(...args) as { data: unknown }[];
    return rows.map(parse);
  }

  /** Done or dropped since `iso` (ISO 8601), newest first. */
  closedSince(iso: string, limit = 200): AheadItem[] {
    const rows = this.db
      .prepare("SELECT data FROM ahead_items WHERE state != 'open' AND changed_at >= ? ORDER BY changed_at DESC LIMIT ?")
      .all(iso, limit) as { data: unknown }[];
    return rows.map(parse);
  }

  /** A bot's open items whose day is before `today` and that it was not yet told about for that day. */
  passedUntold(botId: string, today: string): AheadItem[] {
    const rows = this.db
      .prepare("SELECT data FROM ahead_items WHERE bot_id = ? AND state = 'open' AND day < ? AND (passed_told IS NULL OR passed_told != day) ORDER BY day LIMIT 50")
      .all(botId, today) as { data: unknown }[];
    return rows.map(parse);
  }

  markPassedTold(ids: string[]): void {
    const st = this.db.prepare("UPDATE ahead_items SET passed_told = day WHERE id = ?");
    for (const id of ids) st.run(id);
  }

  /** Forgets items closed before `iso`. */
  forgetClosedBefore(iso: string): number {
    return Number(this.db.prepare("DELETE FROM ahead_items WHERE state != 'open' AND changed_at < ?").run(iso).changes);
  }
}
