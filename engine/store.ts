// The engine's own copy of all history: threads, items, open cards and per thread the harness
// session id. SQLite through node:sqlite, one file, WAL mode, numbered migrations.
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ChannelPostStore, makeChannelPostTables } from "./channel-posts-store.js";
import { CalendarStore, makeCalendarTables } from "./calendar-store.js";
import { ActivityStore, makePersonActionTable } from "./activity-store.js";
import type { Artifact, Card, Channel, ChannelMessage, ChannelRoute, Harness, Item, Schedule, Todo, Trigger, TriggerRun } from "../shared/protocol.js";
import type { TodoRow } from "./todos.js";

/** What the engine keeps about a thread's saved harness session besides its id (step 3a). */
export interface SessionMeta {
  harness: Harness;
  /** Codex: the fingerprint of the tool list the thread was started with. */
  tools?: string;
}

/**
 * "main" is a bot's permanent chat; "run" is the own thread of one fresh trigger run; "helper" is
 * what one helper (the harness's own subagent) said and did, opened from its row in another thread.
 */
export type ThreadKind = "main" | "run" | "helper";

export interface ThreadRow {
  id: string;
  botId: string;
  kind: ThreadKind;
  createdAt: string;
  sessionId: string | null;
  /** For a helper's thread: the helper item that opens it. */
  parentItemId?: string;
}

/** An item as given to `addItem`: everything except the id, thread and seq, which the store assigns. */
export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id" | "threadId" | "seq"> & { id?: string } : never) : never;

/** Numbered migrations. Never edit one that has shipped; add a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    session_id TEXT,
    next_seq INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX threads_bot ON threads (bot_id, kind);
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads (id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    UNIQUE (thread_id, seq)
  );
  CREATE INDEX items_open ON items (open) WHERE open = 1;
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  `,
  // Step 2a: retired bots keep their threads, how far a message from a bot has travelled, and the
  // "Always allow" rules. Nothing existing is dropped or rewritten.
  `
  ALTER TABLE threads ADD COLUMN retired_at TEXT;
  CREATE TABLE message_meta (
    item_id TEXT PRIMARY KEY,
    hops INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    at TEXT NOT NULL,
    UNIQUE (bot_id, rule)
  );
  CREATE TABLE marks (
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  `,
  // Step 2b: triggers (schedules and webhooks), their runs, webhook duplicate keys, and results of
  // fresh runs the bot's main session has not seen yet. A webhook's secret lives only here.
  `
  CREATE TABLE triggers (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    run_in TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    schedule TEXT,
    secret TEXT,
    next_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX triggers_bot ON triggers (bot_id);
  CREATE TABLE trigger_runs (
    id TEXT PRIMARY KEY,
    trigger_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    at TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    thread_id TEXT,
    turn_id TEXT,
    item_id TEXT
  );
  CREATE INDEX trigger_runs_trigger ON trigger_runs (trigger_id);
  CREATE INDEX trigger_runs_item ON trigger_runs (item_id);
  CREATE INDEX trigger_runs_status ON trigger_runs (status);
  CREATE TABLE hook_calls (
    trigger_id TEXT NOT NULL,
    dedupe TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (trigger_id, dedupe)
  );
  CREATE TABLE unseen (
    item_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
  // Step 2c: channels (outside places where people write to bots) and what came in on them. A
  // channel's secret and its address for answers live only here. Nothing existing is touched;
  // webhooks keep their addresses.
  `
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    allowed_senders TEXT NOT NULL,
    routes TEXT NOT NULL,
    context_count INTEGER NOT NULL,
    secret TEXT NOT NULL,
    reply_url TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE channel_messages (
    rid TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    outside_thread_id TEXT,
    at TEXT NOT NULL,
    sender TEXT NOT NULL,
    tag TEXT,
    bot_id TEXT,
    status TEXT NOT NULL,
    note TEXT,
    turn_id TEXT,
    item_id TEXT
  );
  CREATE INDEX channel_messages_channel ON channel_messages (channel_id, message_id);
  CREATE INDEX channel_messages_item ON channel_messages (item_id);
  CREATE INDEX channel_messages_status ON channel_messages (status);
  `,
  // 5: which bot made a trigger (itself, or the main bot for another bot).
  `
  ALTER TABLE triggers ADD COLUMN made_by_bot TEXT;
  `,
  // 6 (step 2d): per thread, how full its harness session is and how long its cache lives, the note
  // a bot wrote for itself before a fresh start, and which turns were tidy turns. The full-text index
  // of the chat is made apart from the migrations, only where SQLite has it (see Store.chatIndex).
  `
  ALTER TABLE threads ADD COLUMN ctx_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN ctx_window INTEGER;
  ALTER TABLE threads ADD COLUMN ctx_since TEXT;
  ALTER TABLE threads ADD COLUMN ctx_cache TEXT;
  ALTER TABLE threads ADD COLUMN ctx_sent_at TEXT;
  ALTER TABLE threads ADD COLUMN fresh_note TEXT;
  ALTER TABLE threads ADD COLUMN fresh_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN tidy_blocked_at TEXT;
  CREATE TABLE tidy_turns (
    turn_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
  // 7 (step 2e): helpers. A helper's thread names the helper item that opens it, and news for a bot
  // that it must hear at its next turn in a thread (helpers that were stopped while it could not know).
  `
  ALTER TABLE threads ADD COLUMN parent_item TEXT;
  CREATE TABLE bot_news (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX bot_news_thread ON bot_news (thread_id);
  `,
  // 8 (step 2f): artifacts. One row per artifact of a bot, kept when it is taken off the list
  // (removed_at) so that old items keep pointing at something, and when its bot is retired.
  // `sig` is what its files looked like when last seen (see filesSignature).
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT,
    url TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    sig TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    retired_at TEXT
  );
  CREATE INDEX artifacts_bot ON artifacts (bot_id, updated_at);
  `,
  // 9 (step 2g): which workspace in the bots' browser belongs to which bot, or is the person's own,
  // kept across a restart and dropped when the browser no longer has it. Plus small values the engine
  // keeps for itself, such as the name of the person's own workspace in the browser's list.
  `
  CREATE TABLE browser_spaces (
    space_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    bot_id TEXT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE engine_values (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 10 (step 3a): which harness a thread's saved session belongs to and, for Codex, a fingerprint of
  // the tool list its thread was started with; and a change between Claude and ChatGPT whose fresh
  // start is still to come.
  `
  ALTER TABLE threads ADD COLUMN session_meta TEXT;
  ALTER TABLE threads ADD COLUMN harness_switch TEXT;
  `,
  // 11 (step 7b): the titles of chats. One row per chat: a session of a main chat (from_seq, and
  // to_seq once a fresh start closed it), a fresh run's thread or a helper's thread (from_seq 0).
  // `upto_seq` is the last message the title was made from. An empty title marks a chat with nothing said.
  `
  CREATE TABLE chat_titles (
    thread_id TEXT NOT NULL,
    from_seq INTEGER NOT NULL,
    to_seq INTEGER,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    upto_seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    made_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, from_seq)
  );
  CREATE INDEX chat_titles_bot ON chat_titles (bot_id, started_at);
  `,
];

/** A chat with its title, as stored (step 7b). See ChatTitle in the protocol. */
export interface TitledChat {
  threadId: string;
  botId: string;
  kind: "main" | "run" | "helper";
  fromSeq: number;
  toSeq?: number;
  title: string;
  uptoSeq: number;
  startedAt: string;
  endedAt?: string;
  madeAt?: string;
}

/** A workspace of the bots' browser that Pobots ties to a bot, or the person's own. */
export interface BrowserSpaceRow {
  spaceId: string;
  kind: "bot" | "you";
  botId?: string;
  name: string;
  createdAt: string;
}

/** An artifact as stored. `removed` and `retired` ones are kept but never listed, opened or changed. */
export interface ArtifactRow extends Artifact {
  sig?: string;
  removed: boolean;
  retired: boolean;
}

/** How full a thread's harness session is, and what Pobots keeps for its next fresh start. */
export interface ThreadContext {
  /** Tokens in the session after its last turn: input, cache read, cache written and output of the last request. */
  tokens: number;
  /** The model's window, as last reported. */
  window?: number;
  /** When the current session started, ISO 8601. */
  since?: string;
  /** How long the session's cache lives, from the last request that wrote to it. */
  cache?: "5m" | "1h";
  /** When the session was last sent to the model, ISO 8601. */
  sentAt?: string;
  /** The note the bot wrote for itself at the last fresh start. */
  note?: string;
  /** True until the note has been handed to the fresh session. */
  notePending: boolean;
  /** When a tidy turn of this session failed. Rules wait for another turn (or another cold spell) before trying again. */
  tidyBlockedAt?: string;
}

/** One message found in a chat by `searchChat`, or read by `readChat`. */
export type ChatHit = Extract<Item, { kind: "user" } | { kind: "bot" }>;

/** What the chat search looks in: what was said, and the names of attached files (so "the invoice pdf" finds it). */
function searchBody(item: ChatHit): string {
  const names = item.kind === "user" ? (item.attachments ?? []).map((a) => a.name) : [];
  return names.length ? [item.text, ...names].join("\n") : item.text;
}

/** A channel as stored. `secret` and `replyUrl` never leave the engine and are never logged. */
export interface ChannelRow {
  id: string;
  kind: Channel["kind"];
  name: string;
  enabled: boolean;
  allowedSenders: string[];
  routes: ChannelRoute[];
  contextCount: number;
  secret: string;
  replyUrl?: string;
  /** The bots that may post here on their own (engine 0.23.0). */
  mayPost: string[];
  createdAt: string;
}

/** One message that came in on a channel, as stored. `rid` is the row's own id; `message.id` is the outside id. */
export interface ChannelMessageRow {
  rid: string;
  message: ChannelMessage;
  /** The outside thread the message belongs to, for the answer. */
  outsideThreadId?: string;
  itemId?: string;
}

/** A trigger as stored. `secret` is the webhook's key: never log it or put it in a bot's folder. */
export interface TriggerRow {
  id: string;
  botId: string;
  kind: Trigger["kind"];
  name: string;
  prompt: string;
  where: Trigger["where"];
  enabled: boolean;
  schedule?: Schedule;
  secret?: string;
  nextAt?: string;
  createdBy: Trigger["createdBy"];
  /** The bot that made it, when a bot did. */
  madeByBotId?: string;
  createdAt: string;
}

/** A saved "Always allow" rule as the harness writes it, for example "Bash(git status:*)". */
export interface RuleRow {
  id: string;
  botId: string;
  rule: string;
  at: string;
}

/** True while an item is still in progress: streaming text, a running tool or a queued message. */
export function isOpenItem(item: Item): boolean {
  switch (item.kind) {
    case "bot":
      return item.streaming;
    case "activity":
      return item.status === "running";
    case "user":
      return item.queued;
    case "helper":
      return item.status === "running";
    case "browser":
      return item.status === "open";
    default:
      return false;
  }
}

export class Store {
  private db: DatabaseSync;
  /** True when SQLite's full-text search is there and the chat index is kept. */
  readonly chatIndex: boolean;
  /** The posts bots wrote in channels on their own (engine 0.23.0). */
  readonly posts: ChannelPostStore;
  /** The calendar connection and what bots did there (engine 0.25.0). */
  readonly calendar: CalendarStore;
  /** The activity log's reads and the person's own actions (engine 0.28.0). */
  readonly activity: ActivityStore;

  /** `fullText: false` leaves the full-text index out, as on a SQLite without it. For tests. */
  constructor(path: string, opts: { fullText?: boolean } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.migrate();
    this.makeTodoTable();
    makeChannelPostTables(this.db);
    this.posts = new ChannelPostStore(this.db);
    makeCalendarTables(this.db);
    this.calendar = new CalendarStore(this.db);
    makePersonActionTable(this.db);
    this.activity = new ActivityStore(this.db);
    this.chatIndex = opts.fullText === false ? false : this.makeChatIndex();
  }

  /**
   * Step 7c (job 7, files-todo): the person's to-dos. `data` is the Todo; `status` "open" while it is on
   * his list, else what became of it. Rows that left the list are kept a while for the bot's "no
   * longer open" answer, and forgotten after 90 days. Made with IF NOT EXISTS beside the migrations
   * (as the chat index is), so the schema number stays and the jobs built side by side merge simply;
   * an older engine that opens the database never reads this table.
   */
  private makeTodoTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        closed_at TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS todos_open ON todos (status, bot_id);
    `);
  }

  /**
   * The full-text index of what was said in the chats (user and bot items), when SQLite has FTS5.
   * Made once and filled from the items already there; kept up to date by addItem and updateItem.
   * Not a migration, so a database is never tied to a SQLite that has it.
   */
  private makeChatIndex(): boolean {
    try {
      const had = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_fts'").get();
      if (had) {
        // Made earlier; usable only where this SQLite has FTS5 too.
        this.db.prepare("SELECT rowid FROM chat_fts LIMIT 0").all();
        return true;
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec("CREATE VIRTUAL TABLE chat_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')");
        this.db.exec("INSERT INTO chat_fts (rowid, body) SELECT rowid, json_extract(data, '$.text') FROM items WHERE kind IN ('user', 'bot')");
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return true;
    } catch {
      return false;
    }
  }

  private indexItem(item: Item): void {
    if (!this.chatIndex || (item.kind !== "user" && item.kind !== "bot")) return;
    const r = this.db.prepare("SELECT rowid AS r FROM items WHERE id = ?").get(item.id) as { r: number } | undefined;
    if (!r) return;
    this.db.prepare("DELETE FROM chat_fts WHERE rowid = ?").run(r.r);
    this.db.prepare("INSERT INTO chat_fts (rowid, body) VALUES (?, ?)").run(r.r, searchBody(item));
  }

  get schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  private migrate(): void {
    const current = this.schemaVersion;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  /**
   * A consistent copy of the whole database into a new file, for the nightly backup: SQLite's online
   * backup on the engine's own handle, a page batch at a time, so it never holds the engine for long
   * and the engine's own writes meanwhile are part of the copy. The copy is one file (no WAL).
   * Resolves with the number of pages. Must finish before the store is closed.
   */
  async snapshotTo(path: string): Promise<number> {
    if (!this.db.isOpen) throw new Error("The database is closed.");
    // node:sqlite's backup works on a thread of its own that does not keep the process alive, and on
    // Node 26 its end does not wake an idle event loop: measured on 13 Nov 2026, a copy of a small
    // database took 8 to 30 seconds on Node 26.5 with nothing else going on, and 0 to 1 ms on the
    // engine's own Node (Electron 44, Node 24.22). A short timer while it runs keeps the process
    // alive and notices the end at once. It runs only for the few milliseconds of the copy.
    const keepAlive = setInterval(() => undefined, 10);
    try {
      return await sqliteBackup(this.db, path, { rate: 256 });
    } finally {
      clearInterval(keepAlive);
    }
  }

  // ------------------------------------------------------------ threads

  createThread(botId: string, kind: ThreadKind = "main", parentItemId?: string): ThreadRow {
    const row: ThreadRow = { id: randomUUID(), botId, kind, createdAt: new Date().toISOString(), sessionId: null, ...(parentItemId ? { parentItemId } : {}) };
    this.db
      .prepare("INSERT INTO threads (id, bot_id, kind, created_at, parent_item) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.botId, row.kind, row.createdAt, parentItemId ?? null);
    return row;
  }

  getThread(id: string): ThreadRow | undefined {
    const r = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toThread(r) : undefined;
  }

  mainThread(botId: string): ThreadRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM threads WHERE bot_id = ? AND kind = 'main' AND retired_at IS NULL ORDER BY created_at LIMIT 1")
      .get(botId) as Record<string, unknown> | undefined;
    return r ? toThread(r) : undefined;
  }

  /** Keeps a retired bot's threads, but never hands them to a new bot with the same id. */
  retireThreads(botId: string): void {
    this.db.prepare("UPDATE threads SET retired_at = ? WHERE bot_id = ? AND retired_at IS NULL").run(new Date().toISOString(), botId);
  }

  setSessionId(threadId: string, sessionId: string | null): void {
    this.db.prepare("UPDATE threads SET session_id = ? WHERE id = ?").run(sessionId, threadId);
  }

  /** Which harness the saved session of a thread belongs to, and (Codex) its tool list's fingerprint. Absent for sessions from before step 3a, which are Claude's. */
  getSessionMeta(threadId: string): SessionMeta | undefined {
    const r = this.db.prepare("SELECT session_meta FROM threads WHERE id = ?").get(threadId) as { session_meta: unknown } | undefined;
    if (!r || r.session_meta == null) return undefined;
    try {
      const v = JSON.parse(String(r.session_meta)) as Record<string, unknown>;
      return { harness: v.harness === "codex" ? "codex" : "claude", ...(typeof v.tools === "string" ? { tools: v.tools } : {}) };
    } catch {
      return undefined;
    }
  }

  setSessionMeta(threadId: string, meta: SessionMeta | null): void {
    this.db.prepare("UPDATE threads SET session_meta = ? WHERE id = ?").run(meta ? JSON.stringify(meta) : null, threadId);
  }

  /** A change between harnesses whose fresh start has not happened yet. */
  getHarnessSwitch(threadId: string): { from: Harness; to: Harness } | undefined {
    const r = this.db.prepare("SELECT harness_switch FROM threads WHERE id = ?").get(threadId) as { harness_switch: unknown } | undefined;
    if (!r || r.harness_switch == null) return undefined;
    try {
      const v = JSON.parse(String(r.harness_switch)) as Record<string, unknown>;
      const h = (x: unknown): Harness => (x === "codex" ? "codex" : "claude");
      return { from: h(v.from), to: h(v.to) };
    } catch {
      return undefined;
    }
  }

  setHarnessSwitch(threadId: string, change: { from: Harness; to: Harness } | null): void {
    this.db.prepare("UPDATE threads SET harness_switch = ? WHERE id = ?").run(change ? JSON.stringify(change) : null, threadId);
  }

  // ------------------------------------------------------------ how full a thread's session is

  getContext(threadId: string): ThreadContext {
    const r = this.db
      .prepare("SELECT ctx_tokens, ctx_window, ctx_since, ctx_cache, ctx_sent_at, fresh_note, fresh_pending, tidy_blocked_at FROM threads WHERE id = ?")
      .get(threadId) as Record<string, unknown> | undefined;
    if (!r) return { tokens: 0, notePending: false };
    return {
      tokens: Number(r.ctx_tokens ?? 0),
      ...(r.ctx_window == null ? {} : { window: Number(r.ctx_window) }),
      ...(r.ctx_since == null ? {} : { since: String(r.ctx_since) }),
      ...(r.ctx_cache === "1h" || r.ctx_cache === "5m" ? { cache: r.ctx_cache } : {}),
      ...(r.ctx_sent_at == null ? {} : { sentAt: String(r.ctx_sent_at) }),
      ...(r.fresh_note == null ? {} : { note: String(r.fresh_note) }),
      notePending: Number(r.fresh_pending) === 1,
      ...(r.tidy_blocked_at == null ? {} : { tidyBlockedAt: String(r.tidy_blocked_at) }),
    };
  }

  /** Changes the fields given. `null` clears a field. */
  setContext(threadId: string, patch: { [K in keyof ThreadContext]?: ThreadContext[K] | null }): void {
    const cols: Record<keyof ThreadContext, string> = {
      tokens: "ctx_tokens",
      window: "ctx_window",
      since: "ctx_since",
      cache: "ctx_cache",
      sentAt: "ctx_sent_at",
      note: "fresh_note",
      notePending: "fresh_pending",
      tidyBlockedAt: "tidy_blocked_at",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof ThreadContext, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${cols[key]} = ?`);
      if (key === "notePending") values.push(value ? 1 : 0);
      else if (key === "tokens") values.push(value === null ? 0 : Number(value));
      else values.push(value === null ? null : (value as string | number));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values, threadId);
  }

  // ------------------------------------------------------------ tidy turns

  addTidyTurn(turnId: string, threadId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO tidy_turns (turn_id, thread_id, at) VALUES (?, ?, ?)").run(turnId, threadId, new Date().toISOString());
  }

  isTidyTurn(turnId: string | undefined): boolean {
    return !!turnId && !!this.db.prepare("SELECT 1 FROM tidy_turns WHERE turn_id = ?").get(turnId);
  }

  // ------------------------------------------------------------ searching a chat

  /**
   * Messages in a thread that hold all the words (any case), newest first. Only what was said: user
   * and bot items, without tidy requests and without what a bot said in a tidy turn. `before` is an
   * ISO time. Uses the full-text index when there is one (words may be the start of a longer word),
   * and a plain search otherwise.
   */
  searchChat(threadId: string, words: string[], opts: { before?: string; limit: number }): ChatHit[] {
    return this.searchSaid({ where: "items.thread_id = ?", arg: threadId, order: "items.seq" }, words, opts);
  }

  /**
   * The same search in the threads of a bot's helpers, both kinds, apart from its own chat (step
   * workers): what each helper was asked and said. Newest first by when it was written.
   */
  searchHelpers(botId: string, words: string[], opts: { before?: string; limit: number }): ChatHit[] {
    return this.searchSaid({ where: "items.thread_id IN (SELECT id FROM threads WHERE bot_id = ? AND kind = 'helper' AND retired_at IS NULL)", arg: botId, order: "items.rowid" }, words, opts);
  }

  private searchSaid(scope: { where: string; arg: string; order: string }, words: string[], opts: { before?: string; limit: number }): ChatHit[] {
    const clean = words.map((w) => w.trim()).filter(Boolean).slice(0, 12);
    if (!clean.length) return [];
    const limit = Math.max(1, Math.min(50, Math.floor(opts.limit)));
    const said = `${scope.where} AND items.kind IN ('user', 'bot')
      AND coalesce(json_extract(items.data, '$.from.type'), '') <> 'app'
      AND coalesce(json_extract(items.data, '$.turnId'), '') NOT IN (SELECT turn_id FROM tidy_turns)
      AND (? IS NULL OR json_extract(items.data, '$.at') < ?)`;
    const before = opts.before ?? null;
    if (this.chatIndex) {
      const match = clean.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ");
      const rows = this.db
        .prepare(`SELECT items.data FROM chat_fts JOIN items ON items.rowid = chat_fts.rowid WHERE chat_fts MATCH ? AND ${said} ORDER BY ${scope.order} DESC LIMIT ?`)
        .all(match, scope.arg, before, before, limit) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as ChatHit);
    }
    const lower = clean.map((w) => w.toLowerCase());
    const out: ChatHit[] = [];
    const stmt = this.db.prepare(`SELECT items.data, ${scope.order} AS o FROM items WHERE ${said} AND ${scope.order} < ? ORDER BY ${scope.order} DESC LIMIT 500`);
    let below = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = stmt.all(scope.arg, before, before, below) as { data: string; o: number }[];
      for (const r of rows) {
        const item = JSON.parse(r.data) as ChatHit;
        below = r.o;
        const text = searchBody(item).toLowerCase();
        if (lower.every((w) => text.includes(w))) out.push(item);
        if (out.length >= limit) return out;
      }
      if (rows.length < 500) return out;
    }
  }

  /** What was said in a thread around a seq, in order: up to half before it, the rest from it on. Same items as searchChat. */
  readChat(threadId: string, around: number, count: number): ChatHit[] {
    const n = Math.max(1, Math.min(30, Math.floor(count)));
    const said = `thread_id = ? AND kind IN ('user', 'bot')
      AND coalesce(json_extract(data, '$.from.type'), '') <> 'app'
      AND coalesce(json_extract(data, '$.turnId'), '') NOT IN (SELECT turn_id FROM tidy_turns)`;
    const half = Math.floor(n / 2);
    const earlier = (this.db.prepare(`SELECT data FROM items WHERE ${said} AND seq < ? ORDER BY seq DESC LIMIT ?`).all(threadId, around, half) as { data: string }[])
      .map((r) => JSON.parse(r.data) as ChatHit)
      .reverse();
    const later = (this.db.prepare(`SELECT data FROM items WHERE ${said} AND seq >= ? ORDER BY seq LIMIT ?`).all(threadId, around, n - earlier.length) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as ChatHit,
    );
    const all = [...earlier, ...later];
    // Near the end of the chat there are fewer later messages: fill up with earlier ones.
    if (all.length < n && earlier.length === half) {
      const first = all[0]?.seq ?? around;
      const more = (this.db.prepare(`SELECT data FROM items WHERE ${said} AND seq < ? ORDER BY seq DESC LIMIT ?`).all(threadId, first, n - all.length) as { data: string }[])
        .map((r) => JSON.parse(r.data) as ChatHit)
        .reverse();
      return [...more, ...all];
    }
    return all;
  }

  // ------------------------------------------------------------ items

  /** Adds an item at the end of a thread. The store assigns the seq, and the id when none is given. */
  addItem(threadId: string, item: NewItem): Item {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const t = this.db.prepare("SELECT next_seq FROM threads WHERE id = ?").get(threadId) as { next_seq: number } | undefined;
      if (!t) throw new Error(`No thread ${threadId}`);
      const seq = t.next_seq;
      const full = { ...item, id: item.id ?? randomUUID(), threadId, seq } as Item;
      this.db.prepare("UPDATE threads SET next_seq = ? WHERE id = ?").run(seq + 1, threadId);
      this.db
        .prepare("INSERT INTO items (id, thread_id, seq, kind, open, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(full.id, threadId, seq, full.kind, isOpenItem(full) ? 1 : 0, JSON.stringify(full));
      this.indexItem(full);
      this.db.exec("COMMIT");
      return full;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Replaces an item that exists, keeping its id, thread and seq. */
  updateItem(item: Item): void {
    this.db
      .prepare("UPDATE items SET data = ?, open = ? WHERE id = ?")
      .run(JSON.stringify(item), isOpenItem(item) ? 1 : 0, item.id);
    this.indexItem(item);
  }

  /**
   * Gives an item a new place at the end of its thread (a new seq), keeping its id: a waiting message
   * the bot takes now stands in the chat where it was read (step 7a). Returns the item as stored.
   */
  moveItemToEnd(item: Item): Item {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const t = this.db.prepare("SELECT next_seq FROM threads WHERE id = ?").get(item.threadId) as { next_seq: number } | undefined;
      if (!t) throw new Error(`No thread ${item.threadId}`);
      const moved = { ...item, seq: t.next_seq } as Item;
      this.db.prepare("UPDATE threads SET next_seq = ? WHERE id = ?").run(t.next_seq + 1, item.threadId);
      this.db.prepare("UPDATE items SET seq = ?, data = ?, open = ? WHERE id = ?").run(moved.seq, JSON.stringify(moved), isOpenItem(moved) ? 1 : 0, moved.id);
      this.indexItem(moved);
      this.db.exec("COMMIT");
      return moved;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Removes an item for good: a waiting message the person took back before the bot read it (step 7a). */
  removeItem(id: string): void {
    const r = this.db.prepare("SELECT rowid AS r FROM items WHERE id = ?").get(id) as { r: number } | undefined;
    if (!r) return;
    if (this.chatIndex) this.db.prepare("DELETE FROM chat_fts WHERE rowid = ?").run(r.r);
    this.db.prepare("DELETE FROM message_meta WHERE item_id = ?").run(id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }

  getItem(id: string): Item | undefined {
    const r = this.db.prepare("SELECT data FROM items WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Item) : undefined;
  }

  /** Reads a thread, newest last. `before` pages backwards by seq. */
  readThread(threadId: string, before?: number, limit = 50): { items: Item[]; hasMore: boolean } {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (
      before === undefined
        ? this.db.prepare("SELECT data FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT ?").all(threadId, n + 1)
        : this.db.prepare("SELECT data FROM items WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(threadId, before, n + 1)
    ) as { data: string }[];
    const hasMore = rows.length > n;
    const items = rows.slice(0, n).map((r) => JSON.parse(r.data) as Item).reverse();
    return { items, hasMore };
  }

  /** A bot's helper rows, newest first: the items its helper threads were made for (read_helper, 15 Nov 2026). */
  helperItems(botId: string, limit = 50): Item[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT i.data AS data FROM threads t JOIN items i ON i.id = t.parent_item WHERE t.bot_id = ? AND t.kind = 'helper' ORDER BY t.rowid DESC LIMIT ?")
      .all(botId, n) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item);
  }

  /** Items still in progress, in thread order. Used at start-up to tidy up after a stop. */
  openItems(): Item[] {
    const rows = this.db.prepare("SELECT data FROM items WHERE open = 1 ORDER BY thread_id, seq").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item);
  }

  /** Queued user items of one thread, oldest first. */
  queuedItems(threadId: string): Item[] {
    const rows = this.db
      .prepare("SELECT data FROM items WHERE thread_id = ? AND open = 1 AND kind = 'user' ORDER BY seq")
      .all(threadId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item).filter((i) => i.kind === "user" && i.queued);
  }

  /** Queued user items of all of a bot's live threads, in the order they were made. */
  queuedItemsOfBot(botId: string): Item[] {
    const rows = this.db
      .prepare(
        "SELECT items.data FROM items JOIN threads ON threads.id = items.thread_id WHERE threads.bot_id = ? AND threads.retired_at IS NULL AND items.open = 1 AND items.kind = 'user' ORDER BY items.rowid",
      )
      .all(botId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item).filter((i) => i.kind === "user" && i.queued);
  }

  // ------------------------------------------------------------ messages between bots

  setHops(itemId: string, hops: number): void {
    this.db.prepare("INSERT OR REPLACE INTO message_meta (item_id, hops) VALUES (?, ?)").run(itemId, hops);
  }

  hops(itemId: string): number {
    const r = this.db.prepare("SELECT hops FROM message_meta WHERE item_id = ?").get(itemId) as { hops: number } | undefined;
    return r ? Number(r.hops) : 0;
  }

  // ------------------------------------------------------------ saved rules

  /** Saves a rule once per bot. Returns the row, new or existing. */
  addRule(botId: string, rule: string, at = new Date().toISOString()): RuleRow {
    this.db.prepare("INSERT OR IGNORE INTO rules (id, bot_id, rule, at) VALUES (?, ?, ?, ?)").run(randomUUID(), botId, rule, at);
    return toRule(this.db.prepare("SELECT * FROM rules WHERE bot_id = ? AND rule = ?").get(botId, rule) as Record<string, unknown>);
  }

  listRules(botId: string): RuleRow[] {
    const rows = this.db.prepare("SELECT * FROM rules WHERE bot_id = ? ORDER BY at, rowid").all(botId) as Record<string, unknown>[];
    return rows.map(toRule);
  }

  getRule(id: string): RuleRow | undefined {
    const r = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toRule(r) : undefined;
  }

  removeRule(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes) > 0;
  }

  removeRulesOf(botId: string): void {
    this.db.prepare("DELETE FROM rules WHERE bot_id = ?").run(botId);
  }

  // ------------------------------------------------------------ marks (things done once)

  hasMark(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM marks WHERE key = ?").get(key);
  }

  setMark(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO marks (key, at) VALUES (?, ?)").run(key, new Date().toISOString());
  }

  // ------------------------------------------------------------ triggers

  addTrigger(t: TriggerRow): void {
    this.db
      .prepare(
        "INSERT INTO triggers (id, bot_id, kind, name, prompt, run_in, enabled, schedule, secret, next_at, created_by, created_at, made_by_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.id, t.botId, t.kind, t.name, t.prompt, t.where, t.enabled ? 1 : 0, t.schedule ? JSON.stringify(t.schedule) : null, t.secret ?? null, t.nextAt ?? null, t.createdBy, t.createdAt, t.madeByBotId ?? null);
  }

  updateTrigger(t: TriggerRow): void {
    this.db
      .prepare("UPDATE triggers SET name = ?, prompt = ?, run_in = ?, enabled = ?, schedule = ?, secret = ?, next_at = ? WHERE id = ?")
      .run(t.name, t.prompt, t.where, t.enabled ? 1 : 0, t.schedule ? JSON.stringify(t.schedule) : null, t.secret ?? null, t.nextAt ?? null, t.id);
  }

  getTrigger(id: string): TriggerRow | undefined {
    const r = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toTrigger(r) : undefined;
  }

  /** A bot's triggers in the order they were made, or every trigger when no bot is named. */
  listTriggers(botId?: string): TriggerRow[] {
    const rows = (
      botId === undefined
        ? this.db.prepare("SELECT * FROM triggers ORDER BY created_at, rowid").all()
        : this.db.prepare("SELECT * FROM triggers WHERE bot_id = ? ORDER BY created_at, rowid").all(botId)
    ) as Record<string, unknown>[];
    return rows.map(toTrigger);
  }

  removeTrigger(id: string): boolean {
    this.db.prepare("DELETE FROM hook_calls WHERE trigger_id = ?").run(id);
    return Number(this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id).changes) > 0;
  }

  // ------------------------------------------------------------ trigger runs (kept when a trigger is removed)

  addRun(run: TriggerRun, itemId?: string): void {
    this.db
      .prepare("INSERT INTO trigger_runs (id, trigger_id, bot_id, at, status, note, thread_id, turn_id, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, run.triggerId, run.botId, run.at, run.status, run.note ?? null, run.threadId ?? null, run.turnId ?? null, itemId ?? null);
  }

  updateRun(run: TriggerRun): void {
    this.db
      .prepare("UPDATE trigger_runs SET status = ?, note = ?, thread_id = ?, turn_id = ? WHERE id = ?")
      .run(run.status, run.note ?? null, run.threadId ?? null, run.turnId ?? null, run.id);
  }

  getRun(id: string): TriggerRun | undefined {
    const r = this.db.prepare("SELECT * FROM trigger_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  /** The run that the given user item started, or waits to start. */
  runByItem(itemId: string): TriggerRun | undefined {
    const r = this.db.prepare("SELECT * FROM trigger_runs WHERE item_id = ?").get(itemId) as Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  lastRun(triggerId: string): TriggerRun | undefined {
    const r = this.db.prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY rowid DESC LIMIT 1").get(triggerId) as Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  /** A run of this trigger that is still going or waiting in line. */
  runningRun(triggerId: string): TriggerRun | undefined {
    const r = this.db.prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1").get(triggerId) as
      | Record<string, unknown>
      | undefined;
    return r ? toRun(r) : undefined;
  }

  /** Runs still marked running, with the item that started them. Used at start-up. */
  openRuns(): { run: TriggerRun; itemId?: string }[] {
    const rows = this.db.prepare("SELECT * FROM trigger_runs WHERE status = 'running' ORDER BY rowid").all() as Record<string, unknown>[];
    return rows.map((r) => ({ run: toRun(r), ...(r.item_id == null ? {} : { itemId: String(r.item_id) }) }));
  }

  /** A trigger's runs, newest first. `before` is a run id. Undefined when `before` is not one of its runs. */
  listRuns(triggerId: string, before: string | undefined, limit: number): { runs: TriggerRun[]; hasMore: boolean } | undefined {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    let rows: Record<string, unknown>[];
    if (before === undefined) {
      rows = this.db.prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY rowid DESC LIMIT ?").all(triggerId, n + 1) as Record<string, unknown>[];
    } else {
      const b = this.db.prepare("SELECT rowid AS r FROM trigger_runs WHERE id = ? AND trigger_id = ?").get(before, triggerId) as { r: number } | undefined;
      if (!b) return undefined;
      rows = this.db
        .prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
        .all(triggerId, b.r, n + 1) as Record<string, unknown>[];
    }
    return { runs: rows.slice(0, n).map(toRun), hasMore: rows.length > n };
  }

  // ------------------------------------------------------------ webhook duplicate keys

  /** True when this key was used for this trigger within `windowMs` before `now`. Forgets older keys. */
  hookSeen(triggerId: string, key: string, now: number, windowMs: number): boolean {
    this.db.prepare("DELETE FROM hook_calls WHERE at < ?").run(new Date(now - windowMs).toISOString());
    return !!this.db.prepare("SELECT 1 FROM hook_calls WHERE trigger_id = ? AND dedupe = ?").get(triggerId, key);
  }

  addHookCall(triggerId: string, key: string, now: number): void {
    this.db.prepare("INSERT OR REPLACE INTO hook_calls (trigger_id, dedupe, at) VALUES (?, ?, ?)").run(triggerId, key, new Date(now).toISOString());
  }

  // ------------------------------------------------------------ step 7c: the person's to-dos

  saveTodo(row: TodoRow): void {
    this.db
      .prepare("INSERT OR REPLACE INTO todos (id, bot_id, at, status, closed_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.todo.id, row.todo.botId, row.todo.at, row.status, row.closedAt ?? null, JSON.stringify(row.todo));
  }

  getTodo(id: string): TodoRow | undefined {
    const r = this.db.prepare("SELECT status, closed_at, data FROM todos WHERE id = ?").get(id) as { status: string; closed_at: string | null; data: string } | undefined;
    return r ? { todo: JSON.parse(r.data) as Todo, status: r.status as TodoRow["status"], ...(r.closed_at ? { closedAt: r.closed_at } : {}) } : undefined;
  }

  /** Open to-dos, oldest first; of one bot when `botId` is given. */
  openTodos(botId?: string): Todo[] {
    const rows = (
      botId
        ? this.db.prepare("SELECT data FROM todos WHERE status = 'open' AND bot_id = ? ORDER BY at, rowid").all(botId)
        : this.db.prepare("SELECT data FROM todos WHERE status = 'open' ORDER BY at, rowid").all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Todo);
  }

  /** Forgets to-dos that left the list more than `days` ago. */
  forgetOldTodos(now: number, days = 90): number {
    const before = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    return Number(this.db.prepare("DELETE FROM todos WHERE status != 'open' AND closed_at IS NOT NULL AND closed_at < ?").run(before).changes);
  }

  // ------------------------------------------------------------ news for a bot's next turn

  addNews(botId: string, threadId: string, text: string): void {
    this.db.prepare("INSERT INTO bot_news (id, bot_id, thread_id, text, at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), botId, threadId, text, new Date().toISOString());
  }

  /** The news for a bot's next turn in a thread, oldest first, and forgets it. */
  takeNews(threadId: string): string[] {
    const rows = this.db.prepare("SELECT text FROM bot_news WHERE thread_id = ? ORDER BY rowid").all(threadId) as { text: string }[];
    this.db.prepare("DELETE FROM bot_news WHERE thread_id = ?").run(threadId);
    return rows.map((r) => String(r.text));
  }

  // ------------------------------------------------------------ results the main session has not seen

  addUnseen(itemId: string, botId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO unseen (item_id, bot_id, at) VALUES (?, ?, ?)").run(itemId, botId, new Date().toISOString());
  }

  /** Item ids, oldest first, and forgets them. */
  takeUnseen(botId: string): string[] {
    const rows = this.db.prepare("SELECT item_id FROM unseen WHERE bot_id = ? ORDER BY rowid").all(botId) as { item_id: string }[];
    this.db.prepare("DELETE FROM unseen WHERE bot_id = ?").run(botId);
    return rows.map((r) => String(r.item_id));
  }

  // ------------------------------------------------------------ channels

  addChannel(c: ChannelRow): void {
    this.db
      .prepare(
        "INSERT INTO channels (id, kind, name, enabled, allowed_senders, routes, context_count, secret, reply_url, may_post, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(c.id, c.kind, c.name, c.enabled ? 1 : 0, JSON.stringify(c.allowedSenders), JSON.stringify(c.routes), c.contextCount, c.secret, c.replyUrl ?? null, JSON.stringify(c.mayPost), c.createdAt);
  }

  updateChannel(c: ChannelRow): void {
    this.db
      .prepare("UPDATE channels SET name = ?, enabled = ?, allowed_senders = ?, routes = ?, context_count = ?, secret = ?, reply_url = ?, may_post = ? WHERE id = ?")
      .run(c.name, c.enabled ? 1 : 0, JSON.stringify(c.allowedSenders), JSON.stringify(c.routes), c.contextCount, c.secret, c.replyUrl ?? null, JSON.stringify(c.mayPost), c.id);
  }

  getChannel(id: string): ChannelRow | undefined {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toChannel(r) : undefined;
  }

  /** Every channel, in the order they were made. */
  listChannels(): ChannelRow[] {
    return (this.db.prepare("SELECT * FROM channels ORDER BY created_at, rowid").all() as Record<string, unknown>[]).map(toChannel);
  }

  /** Removes a channel. What came in on it stays in the database. */
  removeChannel(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM channels WHERE id = ?").run(id).changes) > 0;
  }

  addChannelMessage(row: ChannelMessageRow): void {
    const m = row.message;
    this.db
      .prepare(
        "INSERT INTO channel_messages (rid, channel_id, message_id, outside_thread_id, at, sender, tag, bot_id, status, note, turn_id, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.rid, m.channelId, m.id, row.outsideThreadId ?? null, m.at, m.sender, m.tag ?? null, m.botId ?? null, m.status, m.note ?? null, m.turnId ?? null, row.itemId ?? null);
  }

  /** Changes the outcome of a message: status, note and turn. */
  updateChannelMessage(rid: string, m: ChannelMessage): void {
    this.db.prepare("UPDATE channel_messages SET status = ?, note = ?, turn_id = ? WHERE rid = ?").run(m.status, m.note ?? null, m.turnId ?? null, rid);
  }

  getChannelMessage(rid: string): ChannelMessageRow | undefined {
    const r = this.db.prepare("SELECT * FROM channel_messages WHERE rid = ?").get(rid) as Record<string, unknown> | undefined;
    return r ? toChannelMessage(r) : undefined;
  }

  /** The message a user item came from. */
  channelMessageByItem(itemId: string): ChannelMessageRow | undefined {
    const r = this.db.prepare("SELECT * FROM channel_messages WHERE item_id = ?").get(itemId) as Record<string, unknown> | undefined;
    return r ? toChannelMessage(r) : undefined;
  }

  lastChannelMessage(channelId: string): ChannelMessage | undefined {
    const r = this.db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT 1").get(channelId) as Record<string, unknown> | undefined;
    return r ? toChannelMessage(r).message : undefined;
  }

  /** True when this message id came in on this channel at or after `since` (ISO time). */
  channelMessageSeen(channelId: string, messageId: string, since: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND message_id = ? AND at >= ?").get(channelId, messageId, since);
  }

  /** Messages that were delivered and have no outcome yet. Used at start-up. */
  openChannelMessages(): ChannelMessageRow[] {
    return (this.db.prepare("SELECT * FROM channel_messages WHERE status = 'delivered' ORDER BY rowid").all() as Record<string, unknown>[]).map(toChannelMessage);
  }

  /** A channel's messages, newest first. `before` is a message id. Undefined when `before` is not one of its messages. */
  listChannelMessages(channelId: string, before: string | undefined, limit: number): { messages: ChannelMessage[]; hasMore: boolean } | undefined {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    let rows: Record<string, unknown>[];
    if (before === undefined) {
      rows = this.db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?").all(channelId, n + 1) as Record<string, unknown>[];
    } else {
      const b = this.db.prepare("SELECT MIN(rowid) AS r FROM channel_messages WHERE channel_id = ? AND message_id = ?").get(channelId, before) as { r: number | null } | undefined;
      if (!b || b.r == null) return undefined;
      rows = this.db
        .prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
        .all(channelId, b.r, n + 1) as Record<string, unknown>[];
    }
    return { messages: rows.slice(0, n).map((r) => toChannelMessage(r).message), hasMore: rows.length > n };
  }

  // ------------------------------------------------------------ cards

  /** A card from Pobots itself (kind "system") has no bot or thread: kept with empty ones. */
  addCard(card: Card): void {
    const botId = card.kind === "system" ? "" : card.botId;
    const threadId = card.kind === "system" ? "" : card.threadId;
    this.db
      .prepare("INSERT OR REPLACE INTO cards (id, bot_id, thread_id, at, data) VALUES (?, ?, ?, ?, ?)")
      .run(card.id, botId, threadId, card.at, JSON.stringify(card));
  }

  removeCard(id: string): boolean {
    const r = this.db.prepare("DELETE FROM cards WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /** Open cards, oldest first. */
  listCards(): Card[] {
    const rows = this.db.prepare("SELECT data FROM cards ORDER BY at, rowid").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Card);
  }

  // ------------------------------------------------------------ artifacts

  addArtifact(a: ArtifactRow): void {
    this.db
      .prepare("INSERT INTO artifacts (id, bot_id, kind, title, path, url, rev, available, sig, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.botId, a.kind, a.title, a.path ?? null, a.url ?? null, a.rev, a.available ? 1 : 0, a.sig ?? null, a.createdAt, a.updatedAt);
  }

  /** Changes what can change: kind, title, link, rev, whether its file is there, its files' signature and the time. */
  updateArtifact(a: ArtifactRow): void {
    this.db
      .prepare("UPDATE artifacts SET kind = ?, title = ?, path = ?, url = ?, rev = ?, available = ?, sig = ?, updated_at = ? WHERE id = ?")
      .run(a.kind, a.title, a.path ?? null, a.url ?? null, a.rev, a.available ? 1 : 0, a.sig ?? null, a.updatedAt, a.id);
  }

  /** Any artifact by id, also one taken off the list or of a retired bot. */
  getArtifact(id: string): ArtifactRow | undefined {
    const r = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toArtifact(r) : undefined;
  }

  /** The listed artifact of a bot for an HTML file in its folder. */
  artifactByPath(botId: string, path: string): ArtifactRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM artifacts WHERE bot_id = ? AND path = ? AND removed_at IS NULL AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(botId, path) as Record<string, unknown> | undefined;
    return r ? toArtifact(r) : undefined;
  }

  /** The listed artifact of a bot with this link on Claude. */
  artifactByUrl(botId: string, url: string): ArtifactRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM artifacts WHERE bot_id = ? AND url = ? AND removed_at IS NULL AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(botId, url) as Record<string, unknown> | undefined;
    return r ? toArtifact(r) : undefined;
  }

  /** A bot's listed artifacts, newest change first; or every listed artifact of every bot. */
  listArtifacts(botId?: string): ArtifactRow[] {
    const rows = (
      botId === undefined
        ? this.db.prepare("SELECT * FROM artifacts WHERE removed_at IS NULL AND retired_at IS NULL ORDER BY updated_at DESC, rowid DESC").all()
        : this.db.prepare("SELECT * FROM artifacts WHERE bot_id = ? AND removed_at IS NULL AND retired_at IS NULL ORDER BY updated_at DESC, rowid DESC").all(botId)
    ) as Record<string, unknown>[];
    return rows.map(toArtifact);
  }

  /** Takes an artifact off its bot's list. The row stays. */
  removeArtifact(id: string): boolean {
    return this.db.prepare("UPDATE artifacts SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(new Date().toISOString(), id).changes > 0;
  }

  // ------------------------------------------------------------ the browser

  listBrowserSpaces(): BrowserSpaceRow[] {
    const rows = this.db.prepare("SELECT * FROM browser_spaces ORDER BY created_at, rowid").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      spaceId: String(r.space_id),
      kind: r.kind === "you" ? "you" : "bot",
      ...(r.bot_id == null ? {} : { botId: String(r.bot_id) }),
      name: String(r.name),
      createdAt: String(r.created_at),
    }));
  }

  setBrowserSpace(row: BrowserSpaceRow): void {
    this.db
      .prepare("INSERT INTO browser_spaces (space_id, kind, bot_id, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (space_id) DO UPDATE SET kind = excluded.kind, bot_id = excluded.bot_id, name = excluded.name")
      .run(row.spaceId, row.kind, row.botId ?? null, row.name, row.createdAt);
  }

  removeBrowserSpace(spaceId: string): boolean {
    return this.db.prepare("DELETE FROM browser_spaces WHERE space_id = ?").run(spaceId).changes > 0;
  }

  /** Browser items still open, in thread order. */
  openBrowserItems(): Extract<Item, { kind: "browser" }>[] {
    const rows = this.db.prepare("SELECT data FROM items WHERE open = 1 AND kind = 'browser' ORDER BY thread_id, seq").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item).filter((i): i is Extract<Item, { kind: "browser" }> => i.kind === "browser" && i.status === "open");
  }

  getValue(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM engine_values WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setValue(key: string, value: string): void {
    this.db.prepare("INSERT INTO engine_values (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteValue(key: string): void {
    this.db.prepare("DELETE FROM engine_values WHERE key = ?").run(key);
  }

  /** A retired bot's artifacts go with it. */
  retireArtifacts(botId: string): void {
    this.db.prepare("UPDATE artifacts SET retired_at = ? WHERE bot_id = ? AND retired_at IS NULL").run(new Date().toISOString(), botId);
  }

  // ------------------------------------------------------------ chat titles (step 7b)

  /** Where the main chat's session that holds `beforeSeq` (or the open one) began: after the last fresh start before it, else 1. */
  sessionStart(threadId: string, beforeSeq?: number): number {
    const r = this.db
      .prepare("SELECT max(seq) AS s FROM items WHERE thread_id = ? AND kind = 'notice' AND json_extract(data, '$.mark') = 'fresh' AND (? IS NULL OR seq < ?)")
      .get(threadId, beforeSeq ?? null, beforeSeq ?? null) as { s: number | null } | undefined;
    return r?.s == null ? 1 : r.s + 1;
  }

  /** What was said in a thread from `from` up to `to` (both included; to the end without `to`), in order. The same messages as searchChat. */
  chatRange(threadId: string, from: number, to?: number): ChatHit[] {
    const rows = this.db
      .prepare(
        `SELECT data FROM items WHERE thread_id = ? AND kind IN ('user', 'bot') AND seq >= ? AND (? IS NULL OR seq <= ?)
          AND coalesce(json_extract(data, '$.from.type'), '') <> 'app'
          AND coalesce(json_extract(data, '$.turnId'), '') NOT IN (SELECT turn_id FROM tidy_turns)
          ORDER BY seq LIMIT 2000`,
      )
      .all(threadId, from, to ?? null, to ?? null) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ChatHit).filter((i) => i.kind === "bot" || !i.queued);
  }

  /** How many messages were said after `after` up to `upto`. */
  saidBetween(threadId: string, after: number, upto: number): number {
    const r = this.db.prepare("SELECT count(*) AS n FROM items WHERE thread_id = ? AND kind IN ('user', 'bot') AND seq > ? AND seq <= ?").get(threadId, after, upto) as { n: number };
    return Number(r.n);
  }

  getChatTitle(threadId: string, fromSeq: number): TitledChat | undefined {
    const r = this.db.prepare("SELECT * FROM chat_titles WHERE thread_id = ? AND from_seq = ?").get(threadId, fromSeq) as Record<string, unknown> | undefined;
    return r ? toTitled(r) : undefined;
  }

  setChatTitle(row: Omit<TitledChat, "madeAt">): void {
    this.db
      .prepare(
        `INSERT INTO chat_titles (thread_id, from_seq, to_seq, bot_id, kind, title, upto_seq, started_at, ended_at, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, from_seq) DO UPDATE SET to_seq = excluded.to_seq, title = excluded.title, upto_seq = excluded.upto_seq, started_at = excluded.started_at, ended_at = excluded.ended_at, made_at = excluded.made_at`,
      )
      .run(row.threadId, row.fromSeq, row.toSeq ?? null, row.botId, row.kind, row.title, row.uptoSeq, row.startedAt, row.endedAt ?? null, new Date().toISOString());
  }

  /** A bot's titled chats, newest first, with an empty title left out. `before` is an ISO time. */
  chatTitles(botId: string, opts: { before?: string; limit: number }): { chats: TitledChat[]; hasMore: boolean } {
    const n = Math.max(1, Math.min(100, Math.floor(opts.limit)));
    const rows = this.db
      .prepare("SELECT * FROM chat_titles WHERE bot_id = ? AND title <> '' AND (? IS NULL OR started_at < ?) ORDER BY started_at DESC, from_seq DESC LIMIT ?")
      .all(botId, opts.before ?? null, opts.before ?? null, n + 1) as Record<string, unknown>[];
    return { chats: rows.slice(0, n).map(toTitled), hasMore: rows.length > n };
  }

  /** The title of the main chat's session a message at `seq` belongs to, when it has one. */
  titleAt(threadId: string, seq: number): string | undefined {
    const r = this.db
      .prepare("SELECT title FROM chat_titles WHERE thread_id = ? AND from_seq <= ? AND (to_seq IS NULL OR to_seq >= ?) AND title <> '' ORDER BY from_seq DESC LIMIT 1")
      .get(threadId, seq, seq) as { title: string } | undefined;
    return r?.title;
  }

  /** A bot's chats whose title holds all the words (any case), newest first. */
  searchTitles(botId: string, words: string[], limit: number): TitledChat[] {
    const clean = words.map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 12);
    if (!clean.length) return [];
    const rows = this.db.prepare("SELECT * FROM chat_titles WHERE bot_id = ? AND title <> '' ORDER BY started_at DESC").all(botId) as Record<string, unknown>[];
    return rows
      .map(toTitled)
      .filter((t) => clean.every((w) => t.title.toLowerCase().includes(w)))
      .slice(0, Math.max(1, limit));
  }

  /**
   * Chats that ended and have no title yet, newest first, for the slow backfill: sessions of main
   * chats that a fresh start closed, fresh runs' threads and helpers' threads with nothing still
   * running. Threads of retired bots are left out.
   */
  untitledChats(limit: number): { threadId: string; botId: string; kind: TitledChat["kind"]; fromSeq: number; toSeq?: number }[] {
    const out: { threadId: string; botId: string; kind: TitledChat["kind"]; fromSeq: number; toSeq?: number; at: string }[] = [];
    // Closed sessions of main chats.
    const fresh = this.db
      .prepare(
        `SELECT i.thread_id AS t, i.seq AS s, json_extract(i.data, '$.at') AS at, th.bot_id AS b FROM items i JOIN threads th ON th.id = i.thread_id
          WHERE th.kind = 'main' AND th.retired_at IS NULL AND i.kind = 'notice' AND json_extract(i.data, '$.mark') = 'fresh' ORDER BY i.thread_id, i.seq`,
      )
      .all() as { t: string; s: number; at: string; b: string }[];
    let prevThread = "";
    let prevSeq = 0;
    for (const f of fresh) {
      const from = f.t === prevThread ? prevSeq + 1 : 1;
      prevThread = f.t;
      prevSeq = f.s;
      if (!this.getChatTitle(f.t, from)) out.push({ threadId: f.t, botId: f.b, kind: "main", fromSeq: from, toSeq: f.s, at: f.at });
    }
    // Runs and helpers.
    const threads = this.db
      .prepare(
        `SELECT th.id AS t, th.bot_id AS b, th.kind AS k, th.created_at AS at FROM threads th
          WHERE th.kind IN ('run', 'helper') AND th.retired_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chat_titles c WHERE c.thread_id = th.id)
            AND NOT EXISTS (SELECT 1 FROM items i WHERE i.thread_id = th.id AND i.open = 1)
            AND EXISTS (SELECT 1 FROM items i WHERE i.thread_id = th.id)`,
      )
      .all() as { t: string; b: string; k: string; at: string }[];
    for (const t of threads) {
      // A helper whose row still says running is not over yet.
      const parent = this.getThread(t.t)?.parentItemId;
      const row = parent ? this.getItem(parent) : undefined;
      if (row && row.kind === "helper" && row.status === "running") continue;
      out.push({ threadId: t.t, botId: t.b, kind: t.k === "run" ? "run" : "helper", fromSeq: 0, at: t.at });
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return out.slice(0, Math.max(1, limit)).map(({ at: _at, ...rest }) => rest);
  }
}

function toTitled(r: Record<string, unknown>): TitledChat {
  return {
    threadId: String(r.thread_id),
    botId: String(r.bot_id),
    kind: r.kind === "run" ? "run" : r.kind === "helper" ? "helper" : "main",
    fromSeq: Number(r.from_seq),
    ...(r.to_seq == null ? {} : { toSeq: Number(r.to_seq) }),
    title: String(r.title),
    uptoSeq: Number(r.upto_seq),
    startedAt: String(r.started_at),
    ...(r.ended_at == null ? {} : { endedAt: String(r.ended_at) }),
    ...(r.made_at == null ? {} : { madeAt: String(r.made_at) }),
  };
}

function toArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    id: String(r.id),
    botId: String(r.bot_id),
    kind: r.kind === "link" ? "link" : "page",
    title: String(r.title),
    ...(r.path == null ? {} : { path: String(r.path) }),
    ...(r.url == null ? {} : { url: String(r.url) }),
    rev: Number(r.rev ?? 0),
    available: Number(r.available) === 1,
    ...(r.sig == null ? {} : { sig: String(r.sig) }),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    removed: r.removed_at != null,
    retired: r.retired_at != null,
  };
}

function toRule(r: Record<string, unknown>): RuleRow {
  return { id: String(r.id), botId: String(r.bot_id), rule: String(r.rule), at: String(r.at) };
}

function toTrigger(r: Record<string, unknown>): TriggerRow {
  return {
    id: String(r.id),
    botId: String(r.bot_id),
    kind: r.kind === "webhook" ? "webhook" : "schedule",
    name: String(r.name),
    prompt: String(r.prompt),
    where: r.run_in === "fresh" ? "fresh" : "main",
    enabled: Number(r.enabled) === 1,
    ...(r.schedule == null ? {} : { schedule: JSON.parse(String(r.schedule)) as Schedule }),
    ...(r.secret == null ? {} : { secret: String(r.secret) }),
    ...(r.next_at == null ? {} : { nextAt: String(r.next_at) }),
    createdBy: r.created_by === "bot" ? "bot" : "you",
    ...(r.made_by_bot == null ? {} : { madeByBotId: String(r.made_by_bot) }),
    createdAt: String(r.created_at),
  };
}

function toRun(r: Record<string, unknown>): TriggerRun {
  return {
    id: String(r.id),
    triggerId: String(r.trigger_id),
    botId: String(r.bot_id),
    at: String(r.at),
    status: String(r.status) as TriggerRun["status"],
    ...(r.note == null ? {} : { note: String(r.note) }),
    ...(r.thread_id == null ? {} : { threadId: String(r.thread_id) }),
    ...(r.turn_id == null ? {} : { turnId: String(r.turn_id) }),
  };
}

function toChannel(r: Record<string, unknown>): ChannelRow {
  return {
    id: String(r.id),
    kind: "teams",
    name: String(r.name),
    enabled: Number(r.enabled) === 1,
    allowedSenders: JSON.parse(String(r.allowed_senders)) as string[],
    routes: JSON.parse(String(r.routes)) as ChannelRoute[],
    contextCount: Number(r.context_count),
    secret: String(r.secret),
    ...(r.reply_url == null ? {} : { replyUrl: String(r.reply_url) }),
    mayPost: r.may_post == null ? [] : (JSON.parse(String(r.may_post)) as string[]),
    createdAt: String(r.created_at),
  };
}

function toChannelMessage(r: Record<string, unknown>): ChannelMessageRow {
  return {
    rid: String(r.rid),
    message: {
      id: String(r.message_id),
      channelId: String(r.channel_id),
      at: String(r.at),
      sender: String(r.sender),
      ...(r.tag == null ? {} : { tag: String(r.tag) }),
      ...(r.bot_id == null ? {} : { botId: String(r.bot_id) }),
      status: String(r.status) as ChannelMessage["status"],
      ...(r.note == null ? {} : { note: String(r.note) }),
      ...(r.turn_id == null ? {} : { turnId: String(r.turn_id) }),
    },
    ...(r.outside_thread_id == null ? {} : { outsideThreadId: String(r.outside_thread_id) }),
    ...(r.item_id == null ? {} : { itemId: String(r.item_id) }),
  };
}

function toThread(r: Record<string, unknown>): ThreadRow {
  return {
    id: String(r.id),
    botId: String(r.bot_id),
    kind: r.kind === "run" ? "run" : r.kind === "helper" ? "helper" : "main",
    createdAt: String(r.created_at),
    sessionId: r.session_id == null ? null : String(r.session_id),
    ...(r.parent_item == null ? {} : { parentItemId: String(r.parent_item) }),
  };
}
