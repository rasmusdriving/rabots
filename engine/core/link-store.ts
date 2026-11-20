import type { DatabaseSync } from "node:sqlite";
import type { ConnectionLasts } from "../../shared/protocol.js";
import { LINK_CLOCK_SKEW, LINK_DAY, type Identity, type Invite, type LinkMessage, type LinkWire } from "./link-wire.js";

export interface LinkRow {
  name: string;
  identity: Identity;
  peer?: Invite;
  confirmed?: number;
  entered?: number;
  contact?: number;
  lastMessage?: number;
  paused?: boolean;
  peerPaused?: boolean;
  removing?: boolean;
  ack?: string;
  refused?: string;
  /** 0.44.0: how long it lasts (absent means never), and from when it counts when changed after connecting. */
  lasts?: ConnectionLasts;
  lastsFrom?: number;
  /** 0.44.0: this copy has ended; it answers "removed" and stays in the list for a week. */
  ended?: number;
  endedBy?: "time" | "other";
  /** The other side has been told of the end. */
  endTold?: boolean;
  /** The other side's wire, as last heard. Unknown means try wire 2. */
  peerWire?: LinkWire;
  /** 0.44.0: the id of the bot it belongs to. Absent means the main bot (every older row). */
  owner?: string;
}

/** A received message, with the uploads that hold its files until it is handed on. */
export type InboxMessage = LinkMessage & { uploads?: string[] };
type Inbox = { itemId: string; linkId: string; message: InboxMessage };
export class LinkStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get isOpen(): boolean { return this.db.isOpen; }

  // Additive migration: older engines leave these tables alone and can still open the database.
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pobots_links (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pobots_link_claims (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pobots_link_outbox (
        link_id TEXT NOT NULL REFERENCES pobots_links(id) ON DELETE CASCADE,
        id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (link_id, id)
      );
      CREATE INDEX IF NOT EXISTS pobots_link_outbox_age ON pobots_link_outbox(link_id, at);
      CREATE TABLE IF NOT EXISTS pobots_link_questions (
        link_id TEXT NOT NULL REFERENCES pobots_links(id) ON DELETE CASCADE,
        ref TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY (link_id, ref)
      );
      CREATE INDEX IF NOT EXISTS pobots_link_question_age ON pobots_link_questions(at);
      CREATE TABLE IF NOT EXISTS pobots_link_inbox (
        link_id TEXT NOT NULL REFERENCES pobots_links(id) ON DELETE CASCADE,
        id TEXT NOT NULL, received INTEGER NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL,
        handed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (link_id, id)
      );
      CREATE INDEX IF NOT EXISTS pobots_link_inbox_age ON pobots_link_inbox(link_id, received);
      CREATE INDEX IF NOT EXISTS pobots_link_inbox_pending ON pobots_link_inbox(handed) WHERE handed = 0;
      CREATE TABLE IF NOT EXISTS pobots_link_exchanges (
        link_id TEXT NOT NULL REFERENCES pobots_links(id) ON DELETE CASCADE,
        id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (link_id, id)
      );
      CREATE INDEX IF NOT EXISTS pobots_link_exchange_age ON pobots_link_exchanges(at);
      CREATE TABLE IF NOT EXISTS pobots_link_files (
        link_id TEXT NOT NULL REFERENCES pobots_links(id) ON DELETE CASCADE,
        message TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (link_id, message)
      );
    `);
  }

  rows(): LinkRow[] {
    return (this.db.prepare("SELECT data FROM pobots_links ORDER BY rowid").all() as { data: string }[]).map(r => JSON.parse(r.data) as LinkRow);
  }

  save(row: LinkRow): void {
    this.db.prepare("INSERT INTO pobots_links VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(row.identity.invite.id, JSON.stringify(row));
  }

  paired(row: LinkRow, expires: number): boolean {
    this.db.exec("SAVEPOINT link_pair");
    try {
      const result = this.db.prepare("INSERT OR IGNORE INTO pobots_link_claims VALUES (?, ?)").run(row.peer!.id, expires);
      if (result.changes) this.save(row);
      this.db.exec("RELEASE link_pair");
      return !!result.changes;
    } catch (error) {
      this.db.exec("ROLLBACK TO link_pair; RELEASE link_pair");
      throw error;
    }
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM pobots_links WHERE id = ?").run(id);
  }

  outbox(id: string): LinkMessage[] {
    return (this.db.prepare("SELECT data FROM pobots_link_outbox WHERE link_id = ? ORDER BY at, rowid").all(id) as { data: string }[])
      .map(r => JSON.parse(r.data) as LinkMessage);
  }

  queue(id: string, message: LinkMessage): void {
    const add = () => this.db.prepare("INSERT INTO pobots_link_outbox VALUES (?, ?, ?, ?)").run(id, message.id, message.at, JSON.stringify(message));
    if (message.kind !== "ask") { add(); return; }
    this.db.exec("SAVEPOINT link_ask");
    try {
      add();
      this.saveQuestion(id, `ask:${message.id}`, message.at, Array.from(message.text).slice(0, 200).join(""));
      this.db.exec("RELEASE link_ask");
    } catch (error) {
      this.db.exec("ROLLBACK TO link_ask; RELEASE link_ask");
      throw error;
    }
  }

  // Only locally written text goes here. A peer can refer to its own link's asks, never another link's.
  rememberAnswerQuestion(linkId: string, itemId: string, askId: string, now: number): void {
    const text = this.question(linkId, `ask:${askId}`);
    if (text !== undefined) this.saveQuestion(linkId, `item:${itemId}`, now, text);
  }

  answerQuestion(linkId: string, itemId: string): string | undefined {
    return this.question(linkId, `item:${itemId}`);
  }

  private question(linkId: string, ref: string): string | undefined {
    return (this.db.prepare("SELECT text FROM pobots_link_questions WHERE link_id = ? AND ref = ?").get(linkId, ref) as { text: string } | undefined)?.text;
  }

  private saveQuestion(linkId: string, ref: string, at: number, text: string): void {
    this.db.prepare("INSERT OR IGNORE INTO pobots_link_questions VALUES (?, ?, ?, ?)").run(linkId, ref, at, text);
  }

  sent(id: string, message: string): boolean {
    return !!this.db.prepare("DELETE FROM pobots_link_outbox WHERE link_id = ? AND id = ?").run(id, message).changes;
  }

  seen(id: string, message: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pobots_link_inbox WHERE link_id = ? AND id = ?").get(id, message);
  }

  repeat(id: string, exchange: string, now: number): boolean {
    return !this.db.prepare("INSERT OR IGNORE INTO pobots_link_exchanges VALUES (?, ?, ?)").run(id, exchange, now).changes;
  }

  rate(id: string, since: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM pobots_link_inbox WHERE link_id = ? AND received > ?").get(id, since) as { n: number }).n;
  }

  /** Bytes of files taken on a connection since a time; one message is counted once. */
  fileBytes(id: string, since: number, except = ""): number {
    return (this.db.prepare("SELECT coalesce(sum(bytes), 0) AS n FROM pobots_link_files WHERE link_id = ? AND at > ? AND message <> ?").get(id, since, except) as { n: number }).n;
  }

  countFiles(id: string, message: string, bytes: number, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO pobots_link_files VALUES (?, ?, ?, ?)").run(id, message, now, bytes);
  }

  receive(id: string, message: InboxMessage, itemId: string, now: number): void {
    this.db.prepare("INSERT INTO pobots_link_inbox(link_id, id, received, item_id, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, message.id, now, itemId, JSON.stringify(message));
  }

  /** `skip`: connections whose messages wait (paused, or their bot is on vacation), so they never hold up the others. */
  pending(skip: string[] = []): Inbox[] {
    return (this.db.prepare("SELECT link_id, item_id, data FROM pobots_link_inbox WHERE handed = 0 AND link_id NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 50")
      .all(JSON.stringify(skip)) as
      { link_id: string; item_id: string; data: string }[])
      .map(r => ({ linkId: r.link_id, itemId: r.item_id, message: JSON.parse(r.data) as InboxMessage }));
  }

  handed(linkId: string, id: string): void {
    // Keep the receipt and counts, but do not keep another copy of the message once it is handed on.
    this.db.prepare("UPDATE pobots_link_inbox SET handed = 1, data = '' WHERE link_id = ? AND id = ?").run(linkId, id);
  }

  prune(now: number, inboxAge: number, replayAge: number): void {
    this.db.prepare("DELETE FROM pobots_link_claims WHERE expires <= ?").run(now);
    this.db.prepare("DELETE FROM pobots_link_inbox WHERE received <= ? AND handed = 1").run(now - inboxAge);
    this.db.prepare("DELETE FROM pobots_link_exchanges WHERE at <= ?").run(now - replayAge);
    this.db.prepare("DELETE FROM pobots_link_files WHERE at <= ?").run(now - 3_600_000);
    // An ask and its answer can each wait in the outbox for a day.
    this.db.prepare("DELETE FROM pobots_link_questions WHERE at <= ?").run(now - 2 * LINK_DAY - LINK_CLOCK_SKEW);
  }
}
