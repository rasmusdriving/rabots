// What the activity log reads (engine 0.28.0, docs/build/step-activity-log.md), and the one thing it
// records new: the person's own actions in a window, with where he did them from.
//
// `person_actions` is made with IF NOT EXISTS beside the numbered migrations (as `todos` and
// `channel_posts` are), so the schema number stays and jobs built side by side merge simply; an older
// engine that opens the database never reads it. Only the server writes it, after a window's request
// succeeded, so nothing a bot does is ever counted as his. It holds labels only, never what was written.
//
// The reads take only times, ids, kinds and labels out of the items' JSON: never a message's text,
// a tool's input or a channel message's context.

import type { DatabaseSync } from "node:sqlite";

/** Engine 0.31.0: "question", his question about a to-do or card before he acts. */
export type PersonActionKind = "message" | "card" | "todo" | "stop" | "stop-helper" | "end-task-manager" | "question";
/** Where he did it from: the app on the Mac, a computer's browser over Tailscale, or a phone's. */
export type PersonVia = "mac" | "computer" | "phone";

export interface PersonActionRow {
  id: string;
  /** ISO 8601. */
  at: string;
  kind: PersonActionKind;
  botId?: string;
  threadId?: string;
  /** The item id (a message) or the to-do id. */
  ref?: string;
  via?: PersonVia;
  /** A label: the card's kind and the answer's kind, a to-do's title and what became of it, a helper's title. */
  what?: string;
}

/** One item, as the activity log needs it: times, ids, kinds and labels only. */
export interface ActivityItemRow {
  id: string;
  threadId: string;
  threadKind: string;
  /** The thread's bot. */
  botId: string;
  seq: number;
  kind: string;
  at: string;
  turnId?: string;
  durationMs?: number;
  /** A user item's sender, without its text or context. */
  fromType?: string;
  fromBot?: string;
  fromTaskManager?: string;
  fromLabel?: string;
  fromTriggerId?: string;
  fromResult?: boolean;
  fromChannelId?: string;
  fromSender?: string;
  todoId?: string;
  todoTitle?: string;
  /** Engine 0.31.0: his question about a to-do or card (counted from its own row). */
  question?: boolean;
  steered?: boolean;
  /** A helper item's fields. */
  title?: string;
  helperThreadId?: string;
  status?: string;
  model?: string;
  effort?: string;
  endedAt?: string;
  taskManager?: boolean;
}

export interface CalendarActionLite {
  at: string;
  botId: string;
  action: string;
  subject: string;
  start?: string;
  status: string;
}

export interface ChannelPostLite {
  at: string;
  botId: string;
  channelId: string;
  status: string;
}

export function makePersonActionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_actions (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      bot_id TEXT,
      thread_id TEXT,
      ref TEXT,
      via TEXT,
      what TEXT
    );
    CREATE INDEX IF NOT EXISTS person_actions_at ON person_actions (at);
  `);
}

const ITEM_COLUMNS = `
  i.id AS id, i.thread_id AS threadId, t.kind AS threadKind, t.bot_id AS botId, i.seq AS seq, i.kind AS kind,
  json_extract(i.data, '$.at') AS at,
  json_extract(i.data, '$.turnId') AS turnId,
  json_extract(i.data, '$.durationMs') AS durationMs,
  json_extract(i.data, '$.from.type') AS fromType,
  json_extract(i.data, '$.from.botId') AS fromBot,
  json_extract(i.data, '$.from.taskManager') AS fromTaskManager,
  CASE WHEN json_extract(i.data, '$.from.type') = 'connection' THEN json_extract(i.data, '$.from.name')
    ELSE json_extract(i.data, '$.from.label') END AS fromLabel,
  json_extract(i.data, '$.from.triggerId') AS fromTriggerId,
  json_extract(i.data, '$.from.result') AS fromResult,
  json_extract(i.data, '$.from.channelId') AS fromChannelId,
  json_extract(i.data, '$.from.sender') AS fromSender,
  json_extract(i.data, '$.from.todo.id') AS todoId,
  json_extract(i.data, '$.from.todo.title') AS todoTitle,
  json_extract(i.data, '$.from.question') AS question,
  json_extract(i.data, '$.steered') AS steered,
  CASE WHEN i.kind = 'helper' THEN json_extract(i.data, '$.title') END AS title,
  json_extract(i.data, '$.helperThreadId') AS helperThreadId,
  CASE WHEN i.kind = 'helper' THEN json_extract(i.data, '$.status') END AS status,
  CASE WHEN i.kind = 'helper' THEN json_extract(i.data, '$.model') END AS model,
  CASE WHEN i.kind = 'helper' THEN json_extract(i.data, '$.effort') END AS effort,
  CASE WHEN i.kind = 'helper' THEN json_extract(i.data, '$.endedAt') END AS endedAt,
  CASE WHEN i.kind = 'helper' AND json_extract(i.data, '$.taskManager') IS NOT NULL THEN 1 END AS taskManager
`;

/** The activity log's table and reads. Reached as `store.activity`. */
export class ActivityStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addPersonAction(a: PersonActionRow): void {
    this.db
      .prepare("INSERT INTO person_actions (id, at, kind, bot_id, thread_id, ref, via, what) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.at, a.kind, a.botId ?? null, a.threadId ?? null, a.ref ?? null, a.via ?? null, a.what ?? null);
  }

  /** His actions from `from` (inclusive) to `to` (exclusive), ISO times, oldest first. */
  personActions(from: string, to: string): PersonActionRow[] {
    const rows = this.db.prepare("SELECT * FROM person_actions WHERE at >= ? AND at < ? ORDER BY at, rowid").all(from, to) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      kind: r.kind as PersonActionKind,
      ...(r.bot_id ? { botId: String(r.bot_id) } : {}),
      ...(r.thread_id ? { threadId: String(r.thread_id) } : {}),
      ...(r.ref ? { ref: String(r.ref) } : {}),
      ...(r.via ? { via: r.via as PersonVia } : {}),
      ...(r.what ? { what: String(r.what) } : {}),
    }));
  }

  /**
   * The user, bot, activity, notice and helper items from `from` to `to` (ISO), in every thread,
   * oldest first. Items have no time column, so this reads the time out of each item's JSON.
   */
  itemsBetween(from: string, to: string): ActivityItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${ITEM_COLUMNS} FROM items i JOIN threads t ON t.id = i.thread_id
         WHERE i.kind IN ('user', 'bot', 'activity', 'notice', 'helper', 'artifact', 'browser')
           AND json_extract(i.data, '$.at') >= ? AND json_extract(i.data, '$.at') < ?
         ORDER BY json_extract(i.data, '$.at'), i.seq`,
      )
      .all(from, to) as Record<string, unknown>[];
    return rows.map(toItemRow);
  }

  /** The helper item whose own thread is `helperThreadId`, wherever it stands. For a task manager's thread. */
  helperFor(helperThreadId: string): ActivityItemRow | undefined {
    const r = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM items i JOIN threads t ON t.id = i.thread_id WHERE i.kind = 'helper' AND json_extract(i.data, '$.helperThreadId') = ? LIMIT 1`)
      .get(helperThreadId) as Record<string, unknown> | undefined;
    return r ? toItemRow(r) : undefined;
  }

  /** Every trigger's kind and name, by id. */
  triggers(): Map<string, { kind: string; name: string }> {
    const rows = this.db.prepare("SELECT id, kind, name FROM triggers").all() as { id: string; kind: string; name: string }[];
    return new Map(rows.map((r) => [r.id, { kind: r.kind, name: r.name }]));
  }

  /** Every channel's name, by id. */
  channelNames(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name FROM channels").all() as { id: string; name: string }[];
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Calendar actions from `from` to `to`: no attendees, no note, no meeting id. */
  calendarBetween(from: string, to: string): CalendarActionLite[] {
    const rows = this.db
      .prepare("SELECT at, bot_id, action, subject, start, status FROM calendar_actions WHERE at >= ? AND at < ? ORDER BY at")
      .all(from, to) as Record<string, unknown>[];
    return rows.map((r) => ({
      at: String(r.at),
      botId: String(r.bot_id),
      action: String(r.action),
      subject: String(r.subject ?? ""),
      ...(r.start ? { start: String(r.start) } : {}),
      status: String(r.status),
    }));
  }

  /** Channel posts from `from` to `to`: no text. */
  postsBetween(from: string, to: string): ChannelPostLite[] {
    const rows = this.db.prepare("SELECT at, bot_id, channel_id, status FROM channel_posts WHERE at >= ? AND at < ? ORDER BY at").all(from, to) as Record<string, unknown>[];
    return rows.map((r) => ({ at: String(r.at), botId: String(r.bot_id), channelId: String(r.channel_id), status: String(r.status) }));
  }
}

function toItemRow(r: Record<string, unknown>): ActivityItemRow {
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const out: ActivityItemRow = {
    id: String(r.id),
    threadId: String(r.threadId),
    threadKind: String(r.threadKind),
    botId: String(r.botId),
    seq: Number(r.seq),
    kind: String(r.kind),
    at: String(r.at ?? ""),
  };
  const opt: Partial<ActivityItemRow> = {
    turnId: s(r.turnId),
    durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
    fromType: s(r.fromType),
    fromBot: s(r.fromBot),
    fromTaskManager: s(r.fromTaskManager),
    fromLabel: s(r.fromLabel),
    fromTriggerId: s(r.fromTriggerId),
    fromResult: r.fromResult === 1 || r.fromResult === true ? true : undefined,
    fromChannelId: s(r.fromChannelId),
    fromSender: s(r.fromSender),
    todoId: s(r.todoId),
    todoTitle: s(r.todoTitle),
    question: r.question === 1 || r.question === true ? true : undefined,
    steered: r.steered === 1 || r.steered === true ? true : undefined,
    title: s(r.title),
    helperThreadId: s(r.helperThreadId),
    status: s(r.status),
    model: s(r.model),
    effort: s(r.effort),
    endedAt: s(r.endedAt),
    taskManager: r.taskManager === 1 ? true : undefined,
  };
  for (const [k, v] of Object.entries(opt)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}
