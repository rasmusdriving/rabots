// The posts bots wrote in channels on their own (engine 0.23.0), and the right to write them.
//
// Made with IF NOT EXISTS beside the numbered migrations (as the to-do table is), so the schema
// number stays and jobs built side by side merge simply; an older engine that opens the database
// never reads this table and leaves the channels' new column alone (its INSERT names its columns).

import type { DatabaseSync } from "node:sqlite";

/** One post a bot wrote in a channel. `outsideId` is the post's id in the outside system, when it went out. */
export interface ChannelPostRow {
  id: string;
  channelId: string;
  botId: string;
  /** ISO 8601 time it was tried. */
  at: string;
  text: string;
  status: "posted" | "failed";
  outsideId?: string;
  /** Why it failed, for people. */
  note?: string;
}

/** Makes the posts table and the channels' `may_post` column when they are missing. */
export function makeChannelPostTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_posts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      at TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      outside_id TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS channel_posts_recent ON channel_posts (channel_id, bot_id, at);
    CREATE INDEX IF NOT EXISTS channel_posts_outside ON channel_posts (channel_id, outside_id);
  `);
  const cols = db.prepare("PRAGMA table_info(channels)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "may_post")) db.exec("ALTER TABLE channels ADD COLUMN may_post TEXT NOT NULL DEFAULT '[]'");
}

/** The posts table. Reached as `store.posts`. */
export class ChannelPostStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(p: ChannelPostRow): void {
    this.db
      .prepare("INSERT INTO channel_posts (id, channel_id, bot_id, at, text, status, outside_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.channelId, p.botId, p.at, p.text, p.status, p.outsideId ?? null, p.note ?? null);
  }

  update(p: ChannelPostRow): void {
    this.db.prepare("UPDATE channel_posts SET status = ?, outside_id = ?, note = ? WHERE id = ?").run(p.status, p.outsideId ?? null, p.note ?? null, p.id);
  }

  /** A bot's tries in a channel at or after `since` (ISO time), oldest first. Failed ones count too. */
  triesSince(channelId: string, botId: string, since: string): ChannelPostRow[] {
    return (this.db.prepare("SELECT * FROM channel_posts WHERE channel_id = ? AND bot_id = ? AND at >= ? ORDER BY at, rowid").all(channelId, botId, since) as Record<string, unknown>[]).map(
      toPost,
    );
  }

  /** The post that went out in this channel with this outside id, if a bot wrote it. */
  byOutsideId(channelId: string, outsideId: string): ChannelPostRow | undefined {
    const r = this.db.prepare("SELECT * FROM channel_posts WHERE channel_id = ? AND outside_id = ? AND status = 'posted' ORDER BY rowid DESC LIMIT 1").get(channelId, outsideId) as
      | Record<string, unknown>
      | undefined;
    return r ? toPost(r) : undefined;
  }
}

function toPost(r: Record<string, unknown>): ChannelPostRow {
  return {
    id: String(r.id),
    channelId: String(r.channel_id),
    botId: String(r.bot_id),
    at: String(r.at),
    text: String(r.text),
    status: r.status === "posted" ? "posted" : "failed",
    ...(r.outside_id == null ? {} : { outsideId: String(r.outside_id) }),
    ...(r.note == null ? {} : { note: String(r.note) }),
  };
}
